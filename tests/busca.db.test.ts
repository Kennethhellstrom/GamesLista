import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ListOptions,
  type Queryable,
  type SearchFilters,
  webCountSearchRecords,
  webSearchRecords,
} from "../db.js";

// Testes da issue #4 (banco: busca com filtros combináveis e contagem do resultado).

const RID = "req-4";

let output: string[] = [];

beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

function fakeDb(rows: unknown[] = []): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rows })) };
}

function failingDb(): Queryable {
  return {
    query: vi.fn(async () => {
      throw new Error("conexão recusada");
    }),
  };
}

const PAGE = { page: 1, pageSize: 5, sort: "title", order: "asc" } as const;

/** Executa a busca e devolve o SQL e os parâmetros enviados ao banco. */
async function search(filters: SearchFilters, extra: Partial<ListOptions> = {}): Promise<[string, unknown[]]> {
  const db = fakeDb();
  await webSearchRecords(db, { ...PAGE, ...extra, ...filters }, "web", RID);
  return db.query.mock.calls[0] as [string, unknown[]];
}

describe("webSearchRecords", () => {
  it("sem filtros lista só os jogos ativos, sem condições extras", async () => {
    const [sql, values] = await search({});
    expect(sql).toContain("WHERE active = 1\n");
    expect(sql).toContain("ORDER BY LOWER(title) ASC, id ASC");
    expect(sql).toContain("LIMIT $1 OFFSET $2");
    expect(values).toEqual([5, 0]);
  });

  it("devolve as linhas do banco", async () => {
    const rows = [{ id: 1, title: "Hades" }];
    expect(await webSearchRecords(fakeDb(rows), { ...PAGE }, "web", RID)).toEqual(rows);
  });

  it("filtra o título por trecho, sem diferenciar maiúsculas", async () => {
    const [sql, values] = await search({ q: "zelda" });
    expect(sql).toContain("WHERE active = 1 AND LOWER(title) LIKE '%' || LOWER($1) || '%' ESCAPE '\\'");
    expect(values).toEqual(["zelda", 5, 0]);
  });

  it("filtra a plataforma por igualdade, sem diferenciar maiúsculas", async () => {
    const [sql, values] = await search({ platform: "PC" });
    expect(sql).toContain("WHERE active = 1 AND LOWER(platform) = LOWER($1)");
    expect(values).toEqual(["PC", 5, 0]);
  });

  it("filtra o gênero por igualdade, sem diferenciar maiúsculas", async () => {
    const [sql, values] = await search({ genre: "RPG" });
    expect(sql).toContain("WHERE active = 1 AND LOWER(genre) = LOWER($1)");
    expect(values).toEqual(["RPG", 5, 0]);
  });

  it("filtra o ano inicial (inclusivo)", async () => {
    const [sql, values] = await search({ yearMin: 2018 });
    expect(sql).toContain("WHERE active = 1 AND release_year >= $1");
    expect(values).toEqual([2018, 5, 0]);
  });

  it("filtra o ano final (inclusivo)", async () => {
    const [sql, values] = await search({ yearMax: 2020 });
    expect(sql).toContain("WHERE active = 1 AND release_year <= $1");
    expect(values).toEqual([2020, 5, 0]);
  });

  it("filtra a nota mínima (inclusiva), inclusive o valor 0", async () => {
    const [sql, values] = await search({ ratingMin: 9.5 });
    expect(sql).toContain("WHERE active = 1 AND rating >= $1");
    expect(values).toEqual([9.5, 5, 0]);

    const [zeroSql, zeroValues] = await search({ ratingMin: 0 });
    expect(zeroSql).toContain("AND rating >= $1");
    expect(zeroValues).toEqual([0, 5, 0]);
  });

  it("ignora filtros vazios ou ausentes", async () => {
    const [sql, values] = await search({ q: "", platform: "", genre: "", yearMin: undefined });
    expect(sql).toContain("WHERE active = 1\n");
    expect(values).toEqual([5, 0]);
  });

  it("combina 2 filtros com AND e numera os parâmetros na ordem", async () => {
    const [sql, values] = await search({ platform: "PC", ratingMin: 9 });
    expect(sql).toContain("WHERE active = 1 AND LOWER(platform) = LOWER($1) AND rating >= $2");
    expect(sql).toContain("LIMIT $3 OFFSET $4");
    expect(values).toEqual(["PC", 9, 5, 0]);
  });

  it("combina 3 filtros com AND", async () => {
    const [sql, values] = await search({ genre: "RPG", yearMin: 2015, yearMax: 2022 });
    expect(sql).toContain(
      "WHERE active = 1 AND LOWER(genre) = LOWER($1) AND release_year >= $2 AND release_year <= $3",
    );
    expect(sql).toContain("LIMIT $4 OFFSET $5");
    expect(values).toEqual(["RPG", 2015, 2022, 5, 0]);
  });

  it("combina os 6 filtros de uma vez", async () => {
    const [sql, values] = await search({
      q: "war",
      platform: "PlayStation",
      genre: "Ação",
      yearMin: 2000,
      yearMax: 2024,
      ratingMin: 8,
    });
    expect(sql).toContain("LIMIT $7 OFFSET $8");
    expect(values).toEqual(["war", "PlayStation", "Ação", 2000, 2024, 8, 5, 0]);
  });

  it("escapa curingas do LIKE para valerem como texto literal", async () => {
    const [, values] = await search({ q: "50%_\\" });
    expect(values[0]).toBe("50\\%\\_\\\\");
  });

  it("envia texto malicioso só como parâmetro, nunca dentro do SQL", async () => {
    const attack = "'; DROP TABLE games; --";
    const [sql, values] = await search({ q: attack, platform: attack, genre: attack });
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain(attack);
    expect(values.slice(0, 3)).toEqual([attack, attack, attack]);
  });

  it("ordena por campo permitido, em ordem decrescente, com desempate por id", async () => {
    const [sql] = await search({}, { sort: "rating", order: "desc" });
    expect(sql).toContain("ORDER BY rating DESC, id ASC");
  });

  it("calcula o deslocamento da página", async () => {
    const [, values] = await search({}, { page: 3, pageSize: 10 });
    expect(values).toEqual([10, 20]);
  });

  it("registra na camada db o sucesso da busca", async () => {
    await webSearchRecords(fakeDb(), { ...PAGE }, "web", RID);
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "web",
        operation: "search_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("registra ERROR na camada db e repassa o erro quando o banco falha", async () => {
    await expect(webSearchRecords(failingDb(), { ...PAGE }, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([
      expect.objectContaining({ layer: "db", operation: "search_records", status: "error", level: "ERROR" }),
    ]);
  });
});

describe("webCountSearchRecords", () => {
  it("conta só os jogos ativos quando não há filtros", async () => {
    const db = fakeDb([{ total: "29" }]);
    expect(await webCountSearchRecords(db, {}, "web", RID)).toBe(29);
    expect(db.query).toHaveBeenCalledWith("SELECT COUNT(*) AS total FROM games WHERE active = 1", []);
  });

  it("usa o mesmo WHERE e os mesmos parâmetros da busca, sem LIMIT", async () => {
    const filters: SearchFilters = { platform: "PC", yearMin: 2010, ratingMin: 9 };
    const db = fakeDb([{ total: 4 }]);
    expect(await webCountSearchRecords(db, filters, "web", RID)).toBe(4);
    const [countSql, countValues] = db.query.mock.calls[0] as [string, unknown[]];
    expect(countSql).toBe(
      "SELECT COUNT(*) AS total FROM games WHERE active = 1 AND LOWER(platform) = LOWER($1) AND release_year >= $2 AND rating >= $3",
    );
    const [searchSql, searchValues] = await search(filters);
    expect(searchSql).toContain(countSql.split("WHERE ")[1]);
    expect(countValues).toEqual(searchValues.slice(0, 3));
  });

  it("registra na camada db o sucesso da contagem", async () => {
    await webCountSearchRecords(fakeDb([{ total: 0 }]), {}, "web", RID);
    expect(logs()).toEqual([
      expect.objectContaining({ layer: "db", operation: "count_search_records", status: "success", request_id: RID }),
    ]);
  });

  it("registra ERROR e repassa o erro quando o banco falha", async () => {
    await expect(webCountSearchRecords(failingDb(), {}, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([
      expect.objectContaining({ operation: "count_search_records", status: "error", level: "ERROR" }),
    ]);
  });
});
