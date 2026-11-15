import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

// Testes da issue #6 (rota GET /api/web/dashboard).

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

type FakeDb = Queryable & { query: ReturnType<typeof vi.fn> };

/** Banco falso que responde cada indicador pela agregação usada na consulta. */
function dashboardDb(empty = false): FakeDb {
  return {
    query: vi.fn(async (text: string) => {
      if (empty) return { rows: [] };
      if (text.includes("GROUP BY genre")) {
        return {
          rows: [
            { label: "RPG", value: "2" },
            { label: "Ação", value: "1" },
          ],
        };
      }
      if (text.includes("GROUP BY platform")) return { rows: [{ label: "PC", value: "3" }] };
      return {
        rows: [
          { label: 2018, value: "9.15" },
          { label: 2020, value: "8" },
        ],
      };
    }),
  };
}

async function listen(db: Queryable): Promise<{ base: string; auth: { Authorization: string } }> {
  const tokens = new TokenStore();
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, auth: { Authorization: `Bearer ${tokens.issue("web")}` } };
}

describe("GET /api/web/dashboard", () => {
  it("devolve os 3 indicadores calculados pelo banco", async () => {
    const { base, auth } = await listen(dashboardDb());
    const response = await fetch(`${base}/api/web/dashboard`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      by_genre: [
        { label: "RPG", value: 2 },
        { label: "Ação", value: 1 },
      ],
      by_platform: [{ label: "PC", value: 3 }],
      avg_rating_by_year: [
        { label: "2018", value: 9.15 },
        { label: "2020", value: 8 },
      ],
    });
  });

  it("recalcula a cada chamada (recarregar a página mostra o que o banco tem agora)", async () => {
    const db = dashboardDb();
    const { base, auth } = await listen(db);
    await fetch(`${base}/api/web/dashboard`, { headers: auth });
    await fetch(`${base}/api/web/dashboard`, { headers: auth });
    expect(db.query).toHaveBeenCalledTimes(6);
  });

  it("com a tabela vazia devolve as 3 listas vazias", async () => {
    const { base, auth } = await listen(dashboardDb(true));
    const response = await fetch(`${base}/api/web/dashboard`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ by_genre: [], by_platform: [], avg_rating_by_year: [] });
  });

  it("responde 401 sem token ou com token inválido, sem acessar o banco", async () => {
    const db = dashboardDb();
    const { base } = await listen(db);
    expect((await fetch(`${base}/api/web/dashboard`)).status).toBe(401);
    expect((await fetch(`${base}/api/web/dashboard`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("registra logs db (3 indicadores) e api com o mesmo request_id", async () => {
    const { base, auth } = await listen(dashboardDb());
    const response = await fetch(`${base}/api/web/dashboard`, { headers: auth });
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((e) => e.request_id === requestId);
    expect(entries.map((e) => `${e.layer}:${e.operation}:${e.level}`)).toEqual([
      "db:dashboard_by_genre:INFO",
      "db:dashboard_by_platform:INFO",
      "db:dashboard_avg_rating_by_year:INFO",
      "api:dashboard:INFO",
    ]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const failing: Queryable = {
      query: vi.fn(async () => {
        throw new Error("banco fora do ar");
      }),
    };
    const { base, auth } = await listen(failing);
    const response = await fetch(`${base}/api/web/dashboard`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.operation}`)).toEqual([
      "db:dashboard_by_genre",
      "api:dashboard",
    ]);
  });
});
