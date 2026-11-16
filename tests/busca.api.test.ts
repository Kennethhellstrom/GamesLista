import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

// Testes da issue #4 (rota GET /api/web/records/search).

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

/** Consulta da busca (a que tem LIMIT): [sql, parâmetros]. */
function searchCall(db: FakeDb): [string, unknown[]] {
  return db.query.mock.calls.find((call) => String(call[0]).includes("LIMIT")) as [string, unknown[]];
}

/** Consulta de contagem: [sql, parâmetros]. */
function countCall(db: FakeDb): [string, unknown[]] {
  return db.query.mock.calls.find((call) => String(call[0]).includes("COUNT(*)")) as [string, unknown[]];
}

async function get(query: string, db: FakeDb = gamesDb(ITEMS, 12)) {
  const { base, auth } = await listen(db);
  const response = await fetch(`${base}/api/web/records/search${query}`, { headers: auth });
  return { response, db };
}

describe("GET /api/web/records/search", () => {
  it("sem filtros devolve o mesmo formato da listagem (primeira página, 5 por página)", async () => {
    const { response, db } = await get("");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: ITEMS, page: 1, page_size: 5, total: 12 });
    expect(searchCall(db)[1]).toEqual([5, 0]);
    expect(countCall(db)[1]).toEqual([]);
  });

  it.each([
    ["q", "?q=zelda", "LOWER(title) LIKE", ["zelda"]],
    ["platform", "?platform=PC", "LOWER(platform) = LOWER($1)", ["PC"]],
    ["genre", "?genre=RPG", "LOWER(genre) = LOWER($1)", ["RPG"]],
    ["year_min", "?year_min=2018", "release_year >= $1", [2018]],
    ["year_max", "?year_max=2020", "release_year <= $1", [2020]],
    ["rating_min", "?rating_min=8.5", "rating >= $1", [8.5]],
  ])("filtra por %s sozinho", async (_name, query, condition, params) => {
    const { response, db } = await get(query);
    expect(response.status).toBe(200);
    const [sql, values] = searchCall(db);
    expect(sql).toContain(condition);
    expect(values).toEqual([...params, 5, 0]);
    expect(countCall(db)[1]).toEqual(params);
  });

  it.each([
    ["0", 0],
    ["10", 10],
    ["7", 7],
    ["9.75", 9.75],
  ])("aceita nota mínima %s", async (rating, expected) => {
    const { response, db } = await get(`?rating_min=${rating}`);
    expect(response.status).toBe(200);
    expect(countCall(db)[1]).toEqual([expected]);
  });

  it("combina 2 filtros", async () => {
    const { response, db } = await get("?platform=PC&rating_min=9");
    expect(response.status).toBe(200);
    expect(searchCall(db)[0]).toContain("LOWER(platform) = LOWER($1) AND rating >= $2");
    expect(searchCall(db)[1]).toEqual(["PC", 9, 5, 0]);
    expect(countCall(db)[1]).toEqual(["PC", 9]);
  });

  it("combina 3 filtros e a ordenação e paginação", async () => {
    const { response, db } = await get(
      "?genre=RPG&year_min=2015&year_max=2022&sort=rating&order=desc&page=2&page_size=10",
    );
    expect(await response.json()).toMatchObject({ page: 2, page_size: 10, total: 12 });
    const [sql, values] = searchCall(db);
    expect(sql).toContain("ORDER BY rating DESC, id ASC");
    expect(values).toEqual(["RPG", 2015, 2022, 10, 10]);
    expect(countCall(db)[1]).toEqual(["RPG", 2015, 2022]);
  });

  it("ignora filtros vazios e apara espaços do texto", async () => {
    const { response, db } = await get("?q=&platform=%20%20&genre=%20RPG%20&year_min=&year_max=&rating_min=");
    expect(response.status).toBe(200);
    expect(countCall(db)[1]).toEqual(["RPG"]);
  });

  it("devolve lista vazia e total 0 quando nada corresponde", async () => {
    const { response } = await get("?q=zzz", gamesDb([], 0));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], page: 1, page_size: 5, total: 0 });
  });

  it("aceita intervalo de anos invertido e devolve o que o banco responder (lista vazia)", async () => {
    const { response } = await get("?year_min=2024&year_max=2000", gamesDb([], 0));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0 });
  });

  it("trata tentativa de SQL injection em q como texto comum", async () => {
    const attack = encodeURIComponent("' OR 1=1; DROP TABLE games; --");
    const { response, db } = await get(`?q=${attack}&platform=${attack}`);
    expect(response.status).toBe(200);
    const [sql, values] = searchCall(db);
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("OR 1=1");
    expect(values[0]).toBe("' OR 1=1; DROP TABLE games; --");
  });

  it("escapa % e _ digitados em q", async () => {
    const { db } = await get(`?q=${encodeURIComponent("100%_")}`);
    expect(searchCall(db)[1][0]).toBe("100\\%\\_");
  });

  it.each([
    "rating_min=11",
    "rating_min=10.5",
    "rating_min=-1",
    "rating_min=abc",
    "rating_min=8.555",
    "rating_min=1e1",
    "rating_min=8&rating_min=9",
    "year_min=abc",
    "year_min=0",
    "year_min=-5",
    "year_min=1.5",
    "year_max=x",
    "year_max=2000&year_max=2001",
    `q=${"a".repeat(101)}`,
    "q=a&q=b",
    "platform=PC&platform=Xbox",
    "genre=RPG&genre=Tiro",
    "sort=senha",
    "sort=title;DROP%20TABLE%20games",
    "order=sideways",
    "page=0",
    "page=abc",
    "page_size=0",
    "page_size=101",
  ])("rejeita parâmetros inválidos (%s) com 400, sem chegar ao banco", async (query) => {
    const { response, db } = await get(`?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((e) => e.operation === "search_records")).toMatchObject({ level: "WARN", layer: "api" });
  });

  it("aceita texto de filtro no limite de 100 caracteres", async () => {
    const { response } = await get(`?q=${"a".repeat(100)}`);
    expect(response.status).toBe(200);
  });

  it("responde 401 sem token ou com token inválido", async () => {
    const db = gamesDb(ITEMS);
    const { base } = await listen(db);
    expect((await fetch(`${base}/api/web/records/search`)).status).toBe(401);
    expect((await fetch(`${base}/api/web/records/search?q=a`, { headers: { Authorization: "Bearer x" } })).status).toBe(
      401,
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("registra logs api e db com o mesmo request_id", async () => {
    const { response } = await get("?platform=PC");
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((e) => e.request_id === requestId);
    expect(entries.map((e) => `${e.layer}:${e.operation}:${e.level}`)).toEqual([
      "db:search_records:INFO",
      "db:count_search_records:INFO",
      "api:search_records:INFO",
    ]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records/search?q=a`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.operation}`)).toEqual([
      "db:search_records",
      "api:search_records",
    ]);
  });
});

describe("GET /api/cli/records/search", () => {
  it("devolve a mesma resposta da Web para os mesmos três filtros, paginação e ordenação", async () => {
    const db = gamesDb(ITEMS, 12);
    const { base, auth } = await listen(db);
    const query =
      "?q=ha&platform=PC&genre=Roguelike&year_min=2015&rating_min=8&page=2&page_size=3&sort=rating&order=desc";

    const webResponse = await fetch(`${base}/api/web/records/search${query}`, { headers: auth });
    const cliResponse = await fetch(`${base}/api/cli/records/search${query}`, { headers: auth });

    expect(webResponse.status).toBe(200);
    expect(cliResponse.status).toBe(200);
    expect(await cliResponse.json()).toEqual(await webResponse.json());
    const requestId = cliResponse.headers.get("x-request-id");
    expect(logs().filter((entry) => entry.request_id === requestId).map((entry) => `${entry.layer}:${entry.operation}`)).toEqual([
      "db:cli_search_records",
      "db:cli_count_search_records",
      "api:cli_search_records",
    ]);
  });

  it("rejeita parâmetros inválidos sem consultar o banco", async () => {
    const db = gamesDb(ITEMS);
    const { base, auth } = await listen(db);

    const response = await fetch(`${base}/api/cli/records/search?q=a&q=b`, { headers: auth });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((entry) => entry.operation === "cli_search_records")).toMatchObject({
      level: "WARN",
      client: "cli",
    });
  });

  it("exige token válido", async () => {
    const db = gamesDb(ITEMS);
    const { base } = await listen(db);

    expect((await fetch(`${base}/api/cli/records/search`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/cli/records/search?q=a`, {
          headers: { Authorization: "Bearer inválido" },
        })
      ).status,
    ).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 500 e registra erro quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());

    const response = await fetch(`${base}/api/cli/records/search?platform=PC`, { headers: auth });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((entry) => entry.level === "ERROR").map((entry) => `${entry.layer}:${entry.client}`)).toEqual([
      "db:cli",
      "api:cli",
    ]);
  });
});
