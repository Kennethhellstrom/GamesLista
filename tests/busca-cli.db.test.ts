import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Queryable,
  type SearchFilters,
  cliCountSearchRecords,
  cliSearchRecords,
} from "../db.js";

const RID = "req-10";

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

const OPTIONS = {
  q: "hades",
  platform: "PC",
  genre: "Roguelike",
  yearMin: 2015,
  ratingMin: 8,
  page: 2,
  pageSize: 3,
  sort: "rating",
  order: "desc",
} as const;

describe("cliSearchRecords", () => {
  it("combina ao menos três filtros com parâmetros e usa paginação e ordenação seguras", async () => {
    const db = fakeDb([{ id: 1, title: "Hades" }]);

    await expect(cliSearchRecords(db, OPTIONS, "cli", RID)).resolves.toEqual([{ id: 1, title: "Hades" }]);

    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "WHERE active = 1 AND LOWER(title) LIKE '%' || LOWER($1) || '%' ESCAPE '\\' AND LOWER(platform) = LOWER($2) AND LOWER(genre) = LOWER($3) AND release_year >= $4 AND rating >= $5",
    );
    expect(sql).toContain("ORDER BY rating DESC, id ASC");
    expect(sql).toContain("LIMIT $6 OFFSET $7");
    expect(values).toEqual(["hades", "PC", "Roguelike", 2015, 8, 3, 3]);
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "cli",
        operation: "cli_search_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("não inclui texto de filtro no SQL e escapa curingas do título", async () => {
    const attack = "' OR 1=1; DROP TABLE games; --%_";
    const db = fakeDb();

    await cliSearchRecords(db, { ...OPTIONS, q: attack }, "cli", RID);

    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("DROP TABLE");
    expect(values[0]).toBe("' OR 1=1; DROP TABLE games; --\\%\\_");
  });

  it("propaga falha do banco e registra ERROR", async () => {
    await expect(cliSearchRecords(failingDb(), OPTIONS, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([
      expect.objectContaining({
        level: "ERROR",
        layer: "db",
        client: "cli",
        operation: "cli_search_records",
        request_id: RID,
      }),
    ]);
  });
});

describe("cliCountSearchRecords", () => {
  it("conta usando os mesmos filtros parametrizados da busca", async () => {
    const filters: SearchFilters = { platform: "PC", genre: "RPG", yearMin: 2010 };
    const db = fakeDb([{ total: "4" }]);

    await expect(cliCountSearchRecords(db, filters, "cli", RID)).resolves.toBe(4);
    expect(db.query).toHaveBeenCalledWith(
      "SELECT COUNT(*) AS total FROM games WHERE active = 1 AND LOWER(platform) = LOWER($1) AND LOWER(genre) = LOWER($2) AND release_year >= $3",
      ["PC", "RPG", 2010],
    );
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "cli",
        operation: "cli_count_search_records",
        status: "success",
        request_id: RID,
      }),
    ]);
  });

  it("propaga falha do banco e registra ERROR", async () => {
    await expect(cliCountSearchRecords(failingDb(), {}, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([
      expect.objectContaining({
        level: "ERROR",
        layer: "db",
        client: "cli",
        operation: "cli_count_search_records",
        request_id: RID,
      }),
    ]);
  });
});
