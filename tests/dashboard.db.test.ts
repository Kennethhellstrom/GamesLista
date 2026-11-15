import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, webDashboard } from "../db.js";

// Testes da issue #6 (banco: 3 indicadores do dashboard).

const RID = "req-6";

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

/** Banco falso: devolve as linhas de cada consulta na ordem em que são feitas (gênero, plataforma, ano). */
function sequenceDb(...results: unknown[][]): FakeDb {
  const query = vi.fn();
  for (const rows of results) query.mockResolvedValueOnce({ rows });
  return { query };
}

describe("webDashboard", () => {
  it("faz 3 consultas de agregação e converte os valores (texto do banco) em números", async () => {
    const db = sequenceDb(
      [
        { label: "RPG", value: "7" },
        { label: "Ação", value: "3" },
      ],
      [{ label: "PC", value: "9" }],
      [
        { label: 2018, value: "9.10" },
        { label: 2020, value: "8.5" },
      ],
    );
    const data = await webDashboard(db, "web", RID);
    expect(data).toEqual({
      by_genre: [
        { label: "RPG", value: 7 },
        { label: "Ação", value: 3 },
      ],
      by_platform: [{ label: "PC", value: 9 }],
      avg_rating_by_year: [
        { label: "2018", value: 9.1 },
        { label: "2020", value: 8.5 },
      ],
    });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("agrega por gênero, plataforma e ano, só jogos ativos, sem parâmetros de texto", async () => {
    const db = sequenceDb([], [], []);
    await webDashboard(db, "web", RID);
    const [genre, platform, year] = db.query.mock.calls.map((call) => String(call[0]));
    expect(genre).toContain("GROUP BY genre");
    expect(platform).toContain("GROUP BY platform");
    expect(year).toContain("AVG(rating)");
    expect(year).toContain("GROUP BY release_year");
    for (const sql of [genre, platform, year]) expect(sql).toContain("active = 1");
    for (const call of db.query.mock.calls) expect(call[1]).toBeUndefined();
  });

  it("devolve listas vazias quando não há jogos", async () => {
    const data = await webDashboard(sequenceDb([], [], []), "web", RID);
    expect(data).toEqual({ by_genre: [], by_platform: [], avg_rating_by_year: [] });
  });

  it("registra um log db por indicador com o mesmo request_id", async () => {
    await webDashboard(sequenceDb([], [], []), "web", RID);
    expect(logs().map((e) => `${e.layer}:${e.client}:${e.operation}:${e.status}:${e.request_id}`)).toEqual([
      "db:web:dashboard_by_genre:success:req-6",
      "db:web:dashboard_by_platform:success:req-6",
      "db:web:dashboard_avg_rating_by_year:success:req-6",
    ]);
  });

  it("propaga o erro e registra ERROR quando o banco falha", async () => {
    const db: Queryable = {
      query: vi.fn(async () => {
        throw new Error("conexão recusada");
      }),
    };
    await expect(webDashboard(db, "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()).toEqual([expect.objectContaining({ level: "ERROR", layer: "db", operation: "dashboard_by_genre" })]);
  });
});
