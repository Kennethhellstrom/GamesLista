import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Queryable,
  SEED_GAMES,
  isSortField,
  seedGames,
  webCountRecords,
  webDeleteRecord,
  webListRecords,
} from "../db.js";

// Testes da issue #3 (banco: seed, listagem, contagem e exclusão lógica).

const RID = "req-3";

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

describe("SEED_GAMES", () => {
  it("tem 25+ jogos, 5+ gêneros, 4+ plataformas, anos de 2000 a 2024 e notas variadas", () => {
    expect(SEED_GAMES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(SEED_GAMES.map((g) => g.genre)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(SEED_GAMES.map((g) => g.platform)).size).toBeGreaterThanOrEqual(4);
    const years = SEED_GAMES.map((g) => g.release_year);
    expect(Math.min(...years)).toBe(2000);
    expect(Math.max(...years)).toBe(2024);
    expect(new Set(SEED_GAMES.map((g) => g.rating)).size).toBeGreaterThan(5);
    expect(SEED_GAMES.every((g) => g.rating >= 0 && g.rating <= 10)).toBe(true);
  });
});

describe("seedGames", () => {
  it("insere os jogos de exemplo quando a tabela está vazia", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: "0" }] }).mockResolvedValueOnce({ rows: [] });
    const inserted = await seedGames({ query }, "web", RID);
    expect(inserted).toBe(SEED_GAMES.length);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, values] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO games");
    expect(values).toHaveLength(SEED_GAMES.length * 5);
    expect(values.slice(0, 5)).toEqual([
      SEED_GAMES[0].title,
      SEED_GAMES[0].platform,
      SEED_GAMES[0].genre,
      SEED_GAMES[0].release_year,
      SEED_GAMES[0].rating,
    ]);
    expect(logs().map((e) => e.operation)).toEqual(["seed_games_count", "seed_games"]);
  });

  it("é idempotente: não insere nada quando já existem jogos", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ total: "7" }] });
    expect(await seedGames({ query }, "web", RID)).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(logs()).toHaveLength(1);
  });

  it("conta também os jogos excluídos logicamente, para não recriar o seed", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ total: "1" }] });
    await seedGames({ query }, "web", RID);
    expect(String(query.mock.calls[0][0])).not.toContain("active");
  });

  it("propaga a falha do banco e registra ERROR", async () => {
    await expect(seedGames(failingDb(), "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", layer: "db", operation: "seed_games_count" });
  });
});

describe("isSortField", () => {
  it.each(["id", "title", "platform", "genre", "rating", "release_year"])("aceita %s", (field) => {
    expect(isSortField(field)).toBe(true);
  });

  it.each(["", "password", "title; DROP TABLE games", "toString", "__proto__", 1, null, undefined, ["title"]])(
    "rejeita %j",
    (field) => {
      expect(isSortField(field)).toBe(false);
    },
  );
});

describe("webListRecords", () => {
  it("lista só jogos ativos, calcula LIMIT/OFFSET da primeira página e devolve as linhas", async () => {
    const rows = [{ id: 1, title: "A" }];
    const db = fakeDb(rows);
    const result = await webListRecords(db, { page: 1, pageSize: 5, sort: "id", order: "asc" }, "web", RID);
    expect(result).toBe(rows);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("LIMIT $1 OFFSET $2");
    expect(values).toEqual([5, 0]);
    expect(logs()[0]).toMatchObject({
      level: "INFO",
      layer: "db",
      client: "web",
      operation: "list_records",
      status: "success",
      request_id: RID,
    });
  });

  it("calcula o OFFSET de páginas seguintes e respeita o page_size", async () => {
    const db = fakeDb();
    await webListRecords(db, { page: 6, pageSize: 5, sort: "id", order: "asc" }, "web", RID);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [5, 25]);
    await webListRecords(db, { page: 2, pageSize: 10, sort: "id", order: "asc" }, "web", RID);
    expect(db.query).toHaveBeenLastCalledWith(expect.any(String), [10, 10]);
  });

  it("ordena em ordem crescente e decrescente com desempate por id", async () => {
    const db = fakeDb();
    await webListRecords(db, { page: 1, pageSize: 5, sort: "rating", order: "asc" }, "web", RID);
    await webListRecords(db, { page: 1, pageSize: 5, sort: "rating", order: "desc" }, "web", RID);
    const [asc, desc] = db.query.mock.calls.map((call) => call[0] as string);
    expect(asc).toContain("ORDER BY rating ASC, id ASC");
    expect(desc).toContain("ORDER BY rating DESC, id ASC");
  });

  it("ordena textos sem diferenciar maiúsculas de minúsculas", async () => {
    const db = fakeDb();
    await webListRecords(db, { page: 1, pageSize: 5, sort: "title", order: "asc" }, "web", RID);
    expect(db.query.mock.calls[0][0]).toContain("ORDER BY LOWER(title) ASC");
  });

  it("registra ERROR e propaga a falha do banco", async () => {
    await expect(
      webListRecords(failingDb(), { page: 1, pageSize: 5, sort: "id", order: "asc" }, "web", RID),
    ).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "list_records", status: "error" });
  });
});

describe("webCountRecords", () => {
  it("conta só os jogos ativos e converte o total (texto) em número", async () => {
    const db = fakeDb([{ total: "27" }]);
    expect(await webCountRecords(db, "web", RID)).toBe(27);
    expect(db.query.mock.calls[0][0]).toContain("WHERE active = 1");
    expect(logs()[0]).toMatchObject({ operation: "count_records", status: "success", request_id: RID });
  });
});

describe("webDeleteRecord", () => {
  it("faz a exclusão lógica (active = 0) e devolve true quando o jogo existe", async () => {
    const db = fakeDb([{ id: 4 }]);
    expect(await webDeleteRecord(db, 4, "web", RID)).toBe(true);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE games SET active = 0");
    expect(sql).toContain("active = 1");
    expect(sql).not.toContain("DELETE");
    expect(values).toEqual([4]);
    expect(logs()[0]).toMatchObject({ operation: "delete_record", status: "success", request_id: RID });
  });

  it("devolve false quando o id não existe ou já foi excluído", async () => {
    expect(await webDeleteRecord(fakeDb([]), 999, "web", RID)).toBe(false);
  });
});
