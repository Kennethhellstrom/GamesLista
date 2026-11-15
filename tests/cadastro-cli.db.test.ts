import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GameRecordInput, type Queryable, cliInsertRecord, cliUpdateRecord } from "../db.js";

// Testes da issue #8 (banco: cadastro e edição pela CLI, com SQL próprio).

const RID = "req-8";

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

const INPUT: GameRecordInput = {
  title: "Hades",
  platform: "PC",
  genre: "Outro",
  release_year: 2020,
  rating: 9.3,
  notes: null,
};

describe("cliInsertRecord", () => {
  it("insere com parâmetros, devolve a linha criada e registra o log db da CLI", async () => {
    const row = { id: 30, ...INPUT };
    const db = fakeDb([row]);
    expect(await cliInsertRecord(db, INPUT, "cli", RID)).toEqual(row);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO games (title, platform, genre, release_year, rating, notes)");
    expect(sql).toContain("VALUES ($1, $2, $3, $4, $5, $6)");
    expect(sql).toContain("RETURNING id");
    expect(values).toEqual(["Hades", "PC", "Outro", 2020, 9.3, null]);
    expect(logs()).toEqual([
      expect.objectContaining({
        level: "INFO",
        layer: "db",
        client: "cli",
        operation: "cli_insert_record",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("envia texto malicioso só como parâmetro", async () => {
    const attack = "'); DROP TABLE games; --";
    const db = fakeDb([{ id: 1 }]);
    await cliInsertRecord(db, { ...INPUT, title: attack, notes: attack }, "cli", RID);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("DROP");
    expect(values[0]).toBe(attack);
    expect(values[5]).toBe(attack);
  });

  it("registra ERROR e propaga a falha do banco", async () => {
    await expect(cliInsertRecord(failingDb(), INPUT, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", layer: "db", client: "cli", operation: "cli_insert_record" });
  });
});

describe("cliUpdateRecord", () => {
  it("atualiza todos os campos de um jogo ativo e devolve a linha", async () => {
    const row = { id: 4, ...INPUT, notes: "zerado" };
    const db = fakeDb([row]);
    expect(await cliUpdateRecord(db, 4, { ...INPUT, notes: "zerado" }, "cli", RID)).toEqual(row);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE games");
    expect(sql).toContain("SET title = $2, platform = $3, genre = $4, release_year = $5, rating = $6, notes = $7");
    expect(sql).toContain("WHERE id = $1 AND active = 1");
    expect(values).toEqual([4, "Hades", "PC", "Outro", 2020, 9.3, "zerado"]);
    expect(logs()[0]).toMatchObject({
      layer: "db",
      client: "cli",
      operation: "cli_update_record",
      status: "success",
      request_id: RID,
    });
  });

  it("devolve null quando o id não existe ou foi excluído", async () => {
    expect(await cliUpdateRecord(fakeDb([]), 999, INPUT, "cli", RID)).toBeNull();
  });

  it("registra ERROR e propaga a falha do banco", async () => {
    await expect(cliUpdateRecord(failingDb(), 1, INPUT, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "cli_update_record", status: "error" });
  });
});
