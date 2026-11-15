import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, cliCountRecords, cliDeleteRecord, cliListRecords } from "../db.js";

// Testes da issue #9 (banco: listagem e exclusão lógica pela CLI, com SQL próprio).

const RID = "req-9";

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

const GAME = { id: 3, title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3, notes: null };

describe("cliListRecords", () => {
  it("lista só jogos ativos, com limite e deslocamento da página, e registra o log db da CLI", async () => {
    const db = fakeDb([GAME]);
    const items = await cliListRecords(db, { page: 3, pageSize: 5, sort: "id", order: "asc" }, "cli", RID);
    expect(items).toEqual([GAME]);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("ORDER BY id ASC, id ASC");
    expect(values).toEqual([5, 10]);
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "cli",
        operation: "cli_list_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("ordena em ordem decrescente por uma coluna da lista permitida (sem texto do usuário no SQL)", async () => {
    const db = fakeDb([]);
    await cliListRecords(db, { page: 1, pageSize: 5, sort: "title", order: "desc" }, "cli", RID);
    expect((db.query.mock.calls[0] as [string])[0]).toContain("ORDER BY LOWER(title) DESC, id ASC");
  });

  it("propaga o erro do banco e registra ERROR", async () => {
    await expect(cliListRecords(failingDb(), { page: 1, pageSize: 5, sort: "id", order: "asc" }, "cli", RID)).rejects.toThrow(
      "conexão recusada",
    );
    expect(logs()[0]).toMatchObject({ level: "ERROR", layer: "db", client: "cli", operation: "cli_list_records" });
  });
});

describe("cliCountRecords", () => {
  it("conta só jogos ativos e devolve número", async () => {
    const db = fakeDb([{ total: "12" }]);
    expect(await cliCountRecords(db, "cli", RID)).toBe(12);
    expect((db.query.mock.calls[0] as [string])[0]).toContain("WHERE active = 1");
    expect(logs()[0]).toMatchObject({ layer: "db", client: "cli", operation: "cli_count_records" });
  });
});

describe("cliDeleteRecord", () => {
  it("faz exclusão lógica (active = 0) e devolve true quando o jogo existia", async () => {
    const db = fakeDb([{ id: 4 }]);
    expect(await cliDeleteRecord(db, 4, "cli", RID)).toBe(true);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE games SET active = 0");
    expect(sql).toContain("active = 1");
    expect(sql).not.toContain("DELETE");
    expect(values).toEqual([4]);
    expect(logs()[0]).toMatchObject({ layer: "db", client: "cli", operation: "cli_delete_record", status: "success" });
  });

  it("devolve false quando o id não existe ou já foi excluído", async () => {
    expect(await cliDeleteRecord(fakeDb([]), 99, "cli", RID)).toBe(false);
  });

  it("propaga o erro do banco", async () => {
    await expect(cliDeleteRecord(failingDb(), 1, "cli", RID)).rejects.toThrow("conexão recusada");
  });
});
