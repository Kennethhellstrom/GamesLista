import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { GameRecord, Queryable } from "../db.js";

// Testes da issue #9 (rotas GET /api/cli/records e DELETE /api/cli/records/:id).

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

function game(id: number): GameRecord {
  return { id, title: `Jogo ${id}`, platform: "PC", genre: "Outro", release_year: 2000 + id, rating: 5, notes: null };
}

/** Banco falso com estado: lista (LIMIT/OFFSET), conta e faz exclusão lógica. */
function gamesDb(total = 7): FakeDb {
  const games = Array.from({ length: total }, (_, index) => ({ ...game(index + 1), active: 1 }));
  const visible = () => games.filter((g) => g.active === 1).map(({ active: _active, ...rest }) => rest);
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SET active = 0")) {
        const found = games.find((g) => g.id === values[0] && g.active === 1);
        if (!found) return { rows: [] };
        found.active = 0;
        return { rows: [{ id: found.id }] };
      }
      if (text.includes("COUNT(*)")) return { rows: [{ total: String(visible().length) }] };
      if (text.includes("LIMIT")) {
        const [limit, offset] = values as [number, number];
        return { rows: visible().slice(offset, offset + limit) };
      }
      return { rows: [] };
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

async function listen(db: Queryable): Promise<{ base: string; auth: Record<string, string> }> {
  const tokens = new TokenStore();
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    auth: { Authorization: `Bearer ${tokens.issue("web")}` },
  };
}

describe("GET /api/cli/records", () => {
  it("lista a primeira página (5 por padrão) no formato do contrato e correlaciona os logs api e db da CLI", async () => {
    const { base, auth } = await listen(gamesDb(7));
    const response = await fetch(`${base}/api/cli/records`, { headers: auth });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { items: GameRecord[]; page: number; page_size: number; total: number };
    expect(data).toMatchObject({ page: 1, page_size: 5, total: 7 });
    expect(data.items.map((g) => g.id)).toEqual([1, 2, 3, 4, 5]);
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((e) => e.request_id === requestId).map((e) => `${e.layer}:${e.client}:${e.operation}`)).toEqual([
      "db:cli:cli_list_records",
      "db:cli:cli_count_records",
      "api:cli:cli_list_records",
    ]);
  });

  it("aceita page, page_size, sort e order", async () => {
    const db = gamesDb(7);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/cli/records?page=2&page_size=3&sort=title&order=desc`, { headers: auth });
    const data = (await response.json()) as { items: GameRecord[]; page: number; page_size: number };
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ page: 2, page_size: 3 });
    expect(data.items.map((g) => g.id)).toEqual([4, 5, 6]);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ORDER BY LOWER(title) DESC");
    expect(values).toEqual([3, 3]);
  });

  it.each([
    "page=0",
    "page=abc",
    "page_size=0",
    "page_size=101",
    "sort=senha",
    "sort=id;DROP TABLE games",
    "order=up",
  ])("responde 400 para parâmetros inválidos (%s), sem chegar ao banco", async (query) => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/cli/records?${query}`, { headers: auth });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((e) => e.layer === "api")).toMatchObject({ level: "WARN", client: "cli", operation: "cli_list_records" });
  });

  it("responde 401 sem token e com token inválido, com log client cli", async () => {
    const { base } = await listen(gamesDb());
    expect((await fetch(`${base}/api/cli/records`)).status).toBe(401);
    expect((await fetch(`${base}/api/cli/records`, { headers: { Authorization: "Bearer errado" } })).status).toBe(401);
    expect(logs().filter((e) => e.operation === "auth").map((e) => e.client)).toEqual(["cli", "cli"]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/cli/records`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.client}`)).toEqual(["db:cli", "api:cli"]);
  });
});

describe("DELETE /api/cli/records/:id", () => {
  it("exclui logicamente (204) e o jogo some da listagem, inclusive na Web", async () => {
    const { base, auth } = await listen(gamesDb(3));
    const response = await fetch(`${base}/api/cli/records/2`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(204);
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((e) => e.request_id === requestId).map((e) => `${e.layer}:${e.client}:${e.operation}:${e.level}`)).toEqual([
      "db:cli:cli_delete_record:INFO",
      "api:cli:cli_delete_record:INFO",
    ]);
    const list = (await (await fetch(`${base}/api/cli/records`, { headers: auth })).json()) as { items: GameRecord[]; total: number };
    expect(list.total).toBe(2);
    expect(list.items.map((g) => g.id)).toEqual([1, 3]);
    const web = (await (await fetch(`${base}/api/web/records`, { headers: auth })).json()) as { total: number };
    expect(web.total).toBe(2);
  });

  it("responde 404 para id inexistente ou já excluído", async () => {
    const { base, auth } = await listen(gamesDb(2));
    expect((await fetch(`${base}/api/cli/records/99`, { method: "DELETE", headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/cli/records/1`, { method: "DELETE", headers: auth })).status).toBe(204);
    const again = await fetch(`${base}/api/cli/records/1`, { method: "DELETE", headers: auth });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Jogo não encontrado" });
  });

  it.each(["abc", "0", "-1", "1.5"])("responde 404 para id inválido (%s), sem chegar ao banco", async (id) => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/cli/records/${id}`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 401 sem token", async () => {
    const { base } = await listen(gamesDb());
    expect((await fetch(`${base}/api/cli/records/1`, { method: "DELETE" })).status).toBe(401);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/cli/records/1`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(500);
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.client}`)).toEqual(["db:cli", "api:cli"]);
  });
});
