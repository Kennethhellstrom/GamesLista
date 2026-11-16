import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, cliDashboard } from "../db.js";

// Testes da issue #12 (banco: indicadores pela CLI, com SQL próprio).

const RID = "req-12";

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

/** Banco falso que responde cada indicador pela agregação da consulta (COUNT e AVG chegam como texto). */
function dashboardDb(empty = false): FakeDb {
  return {
    query: vi.fn(async (text: string) => {
      if (empty) return { rows: [] };
      if (text.includes("GROUP BY genre")) return { rows: [{ label: "RPG", value: "2" }, { label: "Ação", value: "1" }] };
      if (text.includes("GROUP BY platform")) return { rows: [{ label: "PC", value: "3" }] };
      return { rows: [{ label: 2018, value: "9.15" }, { label: 2020, value: "8" }] };
    }),
  };
}

describe("cliDashboard", () => {
  it("devolve os 3 indicadores com valores numéricos, no formato do dashboard Web", async () => {
    expect(await cliDashboard(dashboardDb(), "cli", RID)).toEqual({
      by_genre: [{ label: "RPG", value: 2 }, { label: "Ação", value: 1 }],
      by_platform: [{ label: "PC", value: 3 }],
      avg_rating_by_year: [{ label: "2018", value: 9.15 }, { label: "2020", value: 8 }],
    });
  });

  it("faz uma agregação por indicador, só sobre jogos ativos", async () => {
    const db = dashboardDb();
    await cliDashboard(db, "cli", RID);
    const sqls = db.query.mock.calls.map((call) => String(call[0]));
    expect(sqls).toHaveLength(3);
    expect(sqls[0]).toContain("GROUP BY genre");
    expect(sqls[1]).toContain("GROUP BY platform");
    expect(sqls[2]).toContain("GROUP BY release_year");
    expect(sqls[2]).toContain("AVG(rating)");
    for (const sql of sqls) {
      expect(sql).toContain("WHERE active = 1");
    }
  });

  it("registra uma linha de log db da CLI por indicador, com o mesmo request_id", async () => {
    await cliDashboard(dashboardDb(), "cli", RID);
    expect(logs().map((e) => `${e.layer}:${e.client}:${e.operation}:${e.status}:${e.request_id}`)).toEqual([
      "db:cli:cli_dashboard_by_genre:success:req-12",
      "db:cli:cli_dashboard_by_platform:success:req-12",
      "db:cli:cli_dashboard_avg_rating_by_year:success:req-12",
    ]);
  });

  it("devolve listas vazias quando não há jogos ativos", async () => {
    expect(await cliDashboard(dashboardDb(true), "cli", RID)).toEqual({
      by_genre: [],
      by_platform: [],
      avg_rating_by_year: [],
    });
  });

  it("propaga o erro do banco e registra ERROR", async () => {
    const db: Queryable = {
      query: vi.fn(async () => {
        throw new Error("conexão recusada");
      }),
    };
    await expect(cliDashboard(db, "cli", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", layer: "db", client: "cli", operation: "cli_dashboard_by_genre" });
  });
});
