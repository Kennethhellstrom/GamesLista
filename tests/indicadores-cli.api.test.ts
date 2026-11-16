import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

// Testes da issue #12 (rota GET /api/cli/dashboard) e da igualdade com /api/web/dashboard.

let output: string[] = [];
let servers: Server[] = [];

beforeEach(() => {
  output = [];
  servers = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

interface FakeGame {
  genre: string;
  platform: string;
  release_year: number;
  rating: number;
  active: number;
}

const GAMES: FakeGame[] = [
  { genre: "RPG", platform: "PC", release_year: 2018, rating: 9, active: 1 },
  { genre: "RPG", platform: "PC", release_year: 2018, rating: 8.3, active: 1 },
  { genre: "Ação", platform: "PlayStation", release_year: 2020, rating: 7, active: 1 },
  { genre: "Puzzle", platform: "Switch", release_year: 2020, rating: 10, active: 0 },
];

/** Banco falso com dados: agrupa só os jogos ativos, devolvendo COUNT e AVG como texto (como o pg). */
function gamesDb(games: FakeGame[] = GAMES): Queryable {
  const active = games.filter((g) => g.active === 1);
  const countBy = (key: "genre" | "platform") => {
    const counts = new Map<string, number>();
    for (const game of active) counts.set(game[key], (counts.get(game[key]) ?? 0) + 1);
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, value: String(value) }));
  };
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("GROUP BY genre")) return { rows: countBy("genre") };
      if (text.includes("GROUP BY platform")) return { rows: countBy("platform") };
      const years = [...new Set(active.map((g) => g.release_year))].sort();
      return {
        rows: years.map((year) => {
          const ratings = active.filter((g) => g.release_year === year).map((g) => g.rating);
          const avg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
          return { label: year, value: avg.toFixed(2) };
        }),
      };
    }),
  };
}

function failingDb(): Queryable {
  return {
    query: vi.fn(async () => {
      throw new Error("banco fora do ar");
    }),
  };
}

async function listen(db: Queryable): Promise<{ base: string; auth: { Authorization: string } }> {
  const tokens = new TokenStore();
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    auth: { Authorization: `Bearer ${tokens.issue("web")}` },
  };
}

describe("GET /api/cli/dashboard", () => {
  it("devolve os 3 indicadores só com jogos ativos e correlaciona os logs api e db da CLI", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/cli/dashboard`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      by_genre: [{ label: "RPG", value: 2 }, { label: "Ação", value: 1 }],
      by_platform: [{ label: "PC", value: 2 }, { label: "PlayStation", value: 1 }],
      avg_rating_by_year: [{ label: "2018", value: 8.65 }, { label: "2020", value: 7 }],
    });
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((e) => e.request_id === requestId).map((e) => `${e.layer}:${e.client}:${e.operation}`)).toEqual([
      "db:cli:cli_dashboard_by_genre",
      "db:cli:cli_dashboard_by_platform",
      "db:cli:cli_dashboard_avg_rating_by_year",
      "api:cli:cli_dashboard",
    ]);
  });

  it("devolve exatamente os mesmos indicadores de /api/web/dashboard (com dados)", async () => {
    const { base, auth } = await listen(gamesDb());
    const web = await (await fetch(`${base}/api/web/dashboard`, { headers: auth })).json();
    const cli = await (await fetch(`${base}/api/cli/dashboard`, { headers: auth })).json();
    expect(cli).toEqual(web);
    expect((web as { by_genre: unknown[] }).by_genre.length).toBeGreaterThan(0);
  });

  it("devolve os mesmos indicadores da Web também sem jogos (listas vazias)", async () => {
    const { base, auth } = await listen(gamesDb([]));
    const web = await (await fetch(`${base}/api/web/dashboard`, { headers: auth })).json();
    const cli = await (await fetch(`${base}/api/cli/dashboard`, { headers: auth })).json();
    expect(cli).toEqual({ by_genre: [], by_platform: [], avg_rating_by_year: [] });
    expect(cli).toEqual(web);
  });

  it("responde 401 sem token e com token inválido, sem chegar ao banco", async () => {
    const db = gamesDb();
    const { base } = await listen(db);
    expect((await fetch(`${base}/api/cli/dashboard`)).status).toBe(401);
    expect((await fetch(`${base}/api/cli/dashboard`, { headers: { Authorization: "Bearer errado" } })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().filter((e) => e.operation === "auth").map((e) => e.client)).toEqual(["cli", "cli"]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/cli/dashboard`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.client}`)).toEqual(["db:cli", "api:cli"]);
  });
});
