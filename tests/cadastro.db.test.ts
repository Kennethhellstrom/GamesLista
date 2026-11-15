import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GameRecord,
  type GameRecordInput,
  type Queryable,
  SEED_GAMES,
  webInsertRecord,
  webUpdateRecord,
} from "../db.js";

const RID = "req-cadastro";
const INPUT: GameRecordInput = {
  title: "Hades",
  platform: "PC",
  genre: "RPG",
  release_year: 2020,
  rating: 9.3,
  notes: null,
};
const ROW: GameRecord = { id: 8, ...INPUT };

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

describe("SEED_GAMES compatível com os campos permitidos", () => {
  it("usa somente plataformas e gêneros aceitos pelo cadastro Web", () => {
    const platforms = new Set(["PC", "PlayStation", "Xbox", "Switch", "Mobile", "Outro"]);
    const genres = new Set(["Ação", "Aventura", "RPG", "Estratégia", "Esporte", "Corrida", "Puzzle", "Outro"]);
    expect(SEED_GAMES.every((game) => platforms.has(game.platform) && genres.has(game.genre))).toBe(true);
  });
});

describe("webInsertRecord", () => {
  it("insere os seis campos com parâmetros e devolve a linha criada", async () => {
    const db = fakeDb([ROW]);
    await expect(webInsertRecord(db, INPUT, "web", RID)).resolves.toEqual(ROW);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO games");
    expect(sql).toContain("RETURNING id, title, platform, genre, release_year, rating, notes");
    expect(values).toEqual(["Hades", "PC", "RPG", 2020, 9.3, null]);
    expect(logs()[0]).toMatchObject({
      layer: "db",
      client: "web",
      operation: "insert_record",
      request_id: RID,
      status: "success",
    });
  });

  it("devolve null se o banco não retornar a linha", async () => {
    await expect(webInsertRecord(fakeDb(), INPUT, "web", RID)).resolves.toBeNull();
  });

  it("registra erro e propaga falha do banco", async () => {
    await expect(webInsertRecord(failingDb(), INPUT, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "insert_record", request_id: RID });
  });
});

describe("webUpdateRecord", () => {
  it("atualiza somente um jogo ativo e devolve a linha atualizada", async () => {
    const db = fakeDb([ROW]);
    await expect(webUpdateRecord(db, 8, INPUT, "web", RID)).resolves.toEqual(ROW);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE games");
    expect(sql).toContain("WHERE id = $1 AND active = 1");
    expect(sql).toContain("RETURNING id, title, platform, genre, release_year, rating, notes");
    expect(values).toEqual([8, "Hades", "PC", "RPG", 2020, 9.3, null]);
    expect(logs()[0]).toMatchObject({
      layer: "db",
      client: "web",
      operation: "update_record",
      request_id: RID,
      status: "success",
    });
  });

  it("devolve null quando o id não existe ou o jogo está inativo", async () => {
    await expect(webUpdateRecord(fakeDb(), 999, INPUT, "web", RID)).resolves.toBeNull();
  });

  it("registra erro e propaga falha do banco", async () => {
    await expect(webUpdateRecord(failingDb(), 8, INPUT, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "update_record", request_id: RID });
  });
});
