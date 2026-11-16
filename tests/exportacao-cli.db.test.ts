import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, type SearchFilters, cliExportRecords } from "../db.js";

// Testes da issue #11 (banco: exportação CSV pela CLI, sem paginação).

const RID = "req-11";

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

type FakeDb = Queryable & { query: ReturnType<typeof vi.fn> };

function fakeDb(rows: unknown[] = []): FakeDb {
  return { query: vi.fn(async () => ({ rows })) };
}

/** Executa a exportação e devolve o SQL e os parâmetros enviados ao banco. */
async function exportWith(filters: SearchFilters): Promise<[string, unknown[]]> {
  const db = fakeDb();
  await cliExportRecords(db, filters, "cli", RID);
  return db.query.mock.calls[0] as [string, unknown[]];
}

describe("cliExportRecords", () => {
  it("sem filtros exporta todos os jogos ativos, sem paginação e ordenados por id", async () => {
    const [sql, values] = await exportWith({});
    expect(sql).toContain("SELECT id, title, platform, genre, release_year, rating, notes, active");
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("ORDER BY id ASC");
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual([]);
  });

  it("devolve as linhas que o banco responder", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, title: `Jogo ${index + 1}`, active: 1 }));
    await expect(cliExportRecords(fakeDb(rows), {}, "cli", RID)).resolves.toEqual(rows);
  });

  it.each([
    ["q", { q: "zelda" }, "LOWER(title) LIKE", ["zelda"]],
    ["platform", { platform: "PC" }, "LOWER(platform) = LOWER($1)", ["PC"]],
    ["genre", { genre: "RPG" }, "LOWER(genre) = LOWER($1)", ["RPG"]],
    ["yearMin", { yearMin: 2018 }, "release_year >= $1", [2018]],
    ["yearMax", { yearMax: 2020 }, "release_year <= $1", [2020]],
    ["ratingMin", { ratingMin: 8.5 }, "rating >= $1", [8.5]],
  ])("aplica o filtro %s como parâmetro, sem paginação", async (_name, filters, condition, params) => {
    const [sql, values] = await exportWith(filters);
    expect(sql).toContain(condition);
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual(params);
  });

  it("combina vários filtros com AND, na ordem dos parâmetros", async () => {
    const [sql, values] = await exportWith({ platform: "PC", genre: "RPG", yearMin: 2015, ratingMin: 9 });
    expect(sql).toContain("LOWER(platform) = LOWER($1) AND LOWER(genre) = LOWER($2) AND release_year >= $3 AND rating >= $4");
    expect(values).toEqual(["PC", "RPG", 2015, 9]);
  });

  it("trata tentativa de SQL injection como texto, sempre por parâmetro", async () => {
    const attack = "' OR 1=1; DROP TABLE games; --";
    const [sql, values] = await exportWith({ q: attack, platform: attack });
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("OR 1=1");
    expect(values).toContain(attack);
  });

  it("escapa % e _ digitados em q", async () => {
    const [, values] = await exportWith({ q: "100%_" });
    expect(values[0]).toBe("100\\%\\_");
  });

  it("registra log db da CLI com o request_id recebido", async () => {
    await cliExportRecords(fakeDb(), {}, "cli", RID);
    expect(logs()).toEqual([
      expect.objectContaining({
        level: "INFO",
        layer: "db",
        client: "cli",
        operation: "cli_export_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("propaga o erro e registra ERROR quando o banco falha", async () => {
    const db: Queryable = {
      query: vi.fn(async () => {
        throw new Error("conexão recusada");
      }),
    };
    await expect(cliExportRecords(db, {}, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([expect.objectContaining({ level: "ERROR", layer: "db", operation: "cli_export_records" })]);
  });
});
