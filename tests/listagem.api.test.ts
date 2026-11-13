import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StartDeps, TokenStore, createApp, start } from "../api.js";
import type { Queryable } from "../db.js";

// Testes da issue #3 (rotas de listagem/exclusão e seed na inicialização).

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

/** Banco falso: responde ao COUNT com `total` e às demais consultas com `rows`. */
function gamesDb(rows: unknown[], total = rows.length): FakeDb {
  return {
    query: vi.fn(async (text: string) => ({
      rows: text.includes("COUNT(*)") ? [{ total: String(total) }] : rows,
    })),
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, auth: { Authorization: `Bearer ${tokens.issue("web")}` } };
}

const ITEMS = [
  { id: 1, title: "Hades", platform: "PC", genre: "Roguelike", release_year: 2020, rating: 9.3, notes: null },
  { id: 2, title: "Celeste", platform: "PC", genre: "Plataforma", release_year: 2018, rating: 9.1, notes: null },
];

function listCalls(db: FakeDb): [string, unknown[]][] {
  return db.query.mock.calls.filter((call) => String(call[0]).includes("LIMIT")) as [string, unknown[]][];
}

describe("GET /api/web/records", () => {
  it("devolve a primeira página com page_size padrão 5", async () => {
    const db = gamesDb(ITEMS, 27);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: ITEMS, page: 1, page_size: 5, total: 27 });
    expect(listCalls(db)[0][1]).toEqual([5, 0]);
  });

  it("devolve a última página (parcial) e respeita page_size", async () => {
    const db = gamesDb(ITEMS, 27);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records?page=6&page_size=5`, { headers: auth });
    expect(await response.json()).toMatchObject({ page: 6, page_size: 5, total: 27 });
    expect(listCalls(db)[0][1]).toEqual([5, 25]);

    await fetch(`${base}/api/web/records?page_size=10&page=3`, { headers: auth });
    expect(listCalls(db)[1][1]).toEqual([10, 20]);
  });

  it.each([
    ["asc", "ASC"],
    ["desc", "DESC"],
  ])("ordena por campo permitido em ordem %s", async (order, sql) => {
    const db = gamesDb(ITEMS);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records?sort=rating&order=${order}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(listCalls(db)[0][0]).toContain(`ORDER BY rating ${sql}, id ASC`);
  });

  it.each([
    "sort=senha",
    "sort=title;DROP%20TABLE%20games",
    "sort=title&sort=rating",
    "order=sideways",
    "order=asc&order=desc",
    "page=0",
    "page=-1",
    "page=abc",
    "page=1.5",
    "page_size=0",
    "page_size=101",
    "page_size=x",
  ])("rejeita parâmetros inválidos (%s) com 400, sem chegar ao banco", async (query) => {
    const db = gamesDb(ITEMS);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records?${query}`, { headers: auth });
    expect(response.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((e) => e.operation === "list_records")).toMatchObject({ level: "WARN", layer: "api" });
  });

  it("responde 401 sem token ou com token inválido", async () => {
    const db = gamesDb(ITEMS);
    const { base } = await listen(db);
    expect((await fetch(`${base}/api/web/records`)).status).toBe(401);
    expect((await fetch(`${base}/api/web/records`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("registra logs api e db com o mesmo request_id", async () => {
    const { base, auth } = await listen(gamesDb(ITEMS));
    const response = await fetch(`${base}/api/web/records`, { headers: auth });
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((e) => e.request_id === requestId);
    expect(entries.map((e) => `${e.layer}:${e.operation}`)).toEqual([
      "db:list_records",
      "db:count_records",
      "api:list_records",
    ]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => e.layer)).toEqual(["db", "api"]);
  });
});

describe("DELETE /api/web/records/:id", () => {
  it("exclui logicamente o jogo e responde 204 sem corpo", async () => {
    const db = gamesDb([{ id: 3 }]);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/3`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE games SET active = 0"), [3]);
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((e) => e.request_id === requestId);
    expect(entries.map((e) => `${e.layer}:${e.operation}:${e.level}`)).toEqual([
      "db:delete_record:INFO",
      "api:delete_record:INFO",
    ]);
  });

  it("responde 404 quando o id não existe (ou já foi excluído)", async () => {
    const { base, auth } = await listen(gamesDb([]));
    const response = await fetch(`${base}/api/web/records/999`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Jogo não encontrado" });
    expect(logs().find((e) => e.layer === "api")).toMatchObject({ level: "WARN", operation: "delete_record" });
  });

  it.each(["abc", "0", "-4", "1.5"])("responde 404 para id inválido (%s) sem acessar o banco", async (id) => {
    const db = gamesDb([{ id: 1 }]);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/${id}`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 401 sem token", async () => {
    const db = gamesDb([{ id: 1 }]);
    const { base } = await listen(db);
    const response = await fetch(`${base}/api/web/records/1`, { method: "DELETE" });
    expect(response.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records/1`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(500);
    expect(logs().filter((e) => e.level === "ERROR").map((e) => e.layer)).toEqual(["db", "api"]);
  });
});

describe("start com GAMESLIST_SEED", () => {
  const baseEnv = {
    DATABASE_URL: "postgres://x",
    GAMESLIST_ADMIN_USER: "admin",
    GAMESLIST_ADMIN_PASSWORD: "p",
    PORT: "0",
  };

  function deps(): StartDeps {
    return {
      createPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) }) as never),
      initSchema: vi.fn(async () => undefined),
      seedAdminUser: vi.fn(async () => undefined),
      seedGames: vi.fn(async () => 0),
    };
  }

  it("executa o seed de jogos quando GAMESLIST_SEED=true", async () => {
    const d = deps();
    servers.push(await start({ ...baseEnv, GAMESLIST_SEED: "true" }, d));
    expect(d.seedGames).toHaveBeenCalledTimes(1);
    expect(d.seedGames).toHaveBeenCalledWith(expect.anything(), "web", "startup");
  });

  it.each([undefined, "false", "1", ""])("não executa o seed quando GAMESLIST_SEED=%j", async (value) => {
    const d = deps();
    servers.push(await start({ ...baseEnv, GAMESLIST_SEED: value }, d));
    expect(d.seedGames).not.toHaveBeenCalled();
  });
});
