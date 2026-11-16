import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExportRecord,
  type Queryable,
  webExportRecords,
} from "../db.js";

const RID = "req-5";

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

describe("webExportRecords", () => {
  it("exporta todos os jogos ativos sem filtros ou paginação", async () => {
    const records: ExportRecord[] = [
      { id: 1, title: "Hades", platform: "PC", genre: "Roguelike", release_year: 2020, rating: 9.3, notes: null, active: 1 },
    ];
    const db = fakeDb(records);

    await expect(webExportRecords(db, {}, "web", RID)).resolves.toEqual(records);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT id, title, platform, genre, release_year, rating, notes, active");
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("ORDER BY LOWER(title) ASC, id ASC");
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual([]);
  });

  it("combina os filtros da busca e passa todos os valores por parâmetros", async () => {
    const db = fakeDb();
    await webExportRecords(
      db,
      { q: "zelda", platform: "Switch", genre: "RPG", yearMin: 2018, yearMax: 2024, ratingMin: 8.5 },
      "web",
      RID,
    );

    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LOWER(title) LIKE");
    expect(sql).toContain("LOWER(platform) = LOWER($2)");
    expect(sql).toContain("LOWER(genre) = LOWER($3)");
    expect(sql).toContain("release_year >= $4");
    expect(sql).toContain("release_year <= $5");
    expect(sql).toContain("rating >= $6");
    expect(sql).not.toContain("zelda");
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual(["zelda", "Switch", "RPG", 2018, 2024, 8.5]);
  });

  it("registra o sucesso na camada db com o request_id recebido", async () => {
    await webExportRecords(fakeDb(), {}, "web", RID);
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "web",
        operation: "export_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("registra ERROR e repassa a falha do banco", async () => {
    await expect(webExportRecords(failingDb(), {}, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        operation: "export_records",
        status: "error",
        level: "ERROR",
        request_id: RID,
      }),
    ]);
  });
});
