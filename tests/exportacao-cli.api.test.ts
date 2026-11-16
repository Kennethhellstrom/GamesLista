import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

// Testes da issue #11 (rota GET /api/cli/records/export).

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

function gamesDb(rows: unknown[]): FakeDb {
  return { query: vi.fn(async () => ({ rows })) };
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
  return { base, auth: { Authorization: `Bearer ${tokens.issue("cli")}` } };
}

function games(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `Jogo ${index + 1}`,
    platform: "PC",
    genre: "RPG",
    release_year: 2020,
    rating: 9,
    notes: null,
    active: 1,
  }));
}

const HEADER = '"id","title","platform","genre","release_year","rating","notes","active"';

describe("GET /api/cli/records/export", () => {
  it("sem filtros exporta todos os jogos (mais de 5), sem paginação, em CSV para download", async () => {
    const db = gamesDb(games(7));
    const { base, auth } = await listen(db);

    const response = await fetch(`${base}/api/cli/records/export`, { headers: auth });
    const lines = (await response.text()).split("\r\n");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="games.csv"');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(HEADER);
    expect(lines[7]).toBe('"7","Jogo 7","PC","RPG","2020","9","","1"');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(db.query.mock.calls[0][1]).toEqual([]);
  });

  it("repassa os 6 filtros ao banco como parâmetros", async () => {
    const db = gamesDb(games(2));
    const { base, auth } = await listen(db);

    const response = await fetch(
      `${base}/api/cli/records/export?q=zelda&platform=PC&genre=RPG&year_min=2015&year_max=2022&rating_min=8.5`,
      { headers: auth },
    );

    expect(response.status).toBe(200);
    expect(db.query.mock.calls[0][1]).toEqual(["zelda", "PC", "RPG", 2015, 2022, 8.5]);
  });

  it("escapa vírgula, aspas e quebra de linha e exporta observação vazia", async () => {
    const db = gamesDb([
      { id: 1, title: 'Jogo, "com" aspas', platform: "PC", genre: "RPG", release_year: 2020, rating: 9.5, notes: "linha 1\nlinha 2", active: 1 },
      { id: 2, title: "Sem notas", platform: "PC", genre: "RPG", release_year: 2021, rating: 8, notes: null, active: 1 },
    ]);
    const { base, auth } = await listen(db);

    const csv = await (await fetch(`${base}/api/cli/records/export`, { headers: auth })).text();

    expect(csv).toBe(
      [
        HEADER,
        '"1","Jogo, ""com"" aspas","PC","RPG","2020","9.5","linha 1\nlinha 2","1"',
        '"2","Sem notas","PC","RPG","2021","8","","1"',
      ].join("\r\n"),
    );
  });

  it("sem jogos devolve só o cabeçalho", async () => {
    const { base, auth } = await listen(gamesDb([]));
    const response = await fetch(`${base}/api/cli/records/export?q=zzz`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HEADER);
  });

  it("responde 401 sem token ou com token inválido, sem acessar o banco", async () => {
    const db = gamesDb(games(1));
    const { base } = await listen(db);
    expect((await fetch(`${base}/api/cli/records/export`)).status).toBe(401);
    expect((await fetch(`${base}/api/cli/records/export`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    "rating_min=11",
    "rating_min=-1",
    "rating_min=abc",
    "rating_min=8.555",
    "rating_min=8&rating_min=9",
    "year_min=abc",
    "year_min=0",
    "year_max=1.5",
    "year_max=2000&year_max=2001",
    `q=${"a".repeat(101)}`,
    "q=a&q=b",
    "platform=PC&platform=Xbox",
    "genre=RPG&genre=Tiro",
  ])("rejeita filtro inválido (%s) com 400, sem chegar ao banco", async (query) => {
    const db = gamesDb(games(1));
    const { base, auth } = await listen(db);

    const response = await fetch(`${base}/api/cli/records/export?${query}`, { headers: auth });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((e) => e.operation === "cli_export_records")).toMatchObject({
      level: "WARN",
      layer: "api",
      client: "cli",
    });
  });

  it("registra logs db e api da CLI com o mesmo request_id", async () => {
    const { base, auth } = await listen(gamesDb(games(3)));
    const response = await fetch(`${base}/api/cli/records/export?platform=PC`, { headers: auth });
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((e) => e.request_id === requestId);
    expect(entries.map((e) => `${e.layer}:${e.client}:${e.operation}:${e.level}`)).toEqual([
      "db:cli:cli_export_records:INFO",
      "api:cli:cli_export_records:INFO",
    ]);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/cli/records/export`, { headers: auth });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.operation}`)).toEqual([
      "db:cli_export_records",
      "api:cli_export_records",
    ]);
  });

  it("CLI e Web exportam o mesmo conteúdo e usam os mesmos parâmetros para os mesmos filtros", async () => {
    const rows = [
      ...games(6),
      { id: 7, title: 'Com, "aspas"', platform: "PC", genre: "RPG", release_year: 2022, rating: 9.4, notes: "a\nb", active: 1 },
    ];
    const queries = [
      "",
      "?platform=PC&rating_min=9",
      "?q=zelda&genre=RPG&year_min=2015&year_max=2022",
      "?q=zzz&platform=PC&genre=RPG&year_min=2015&year_max=2022&rating_min=8.5",
    ];

    for (const query of queries) {
      const webDb = gamesDb(rows);
      const web = await listen(webDb);
      const cliDb = gamesDb(rows);
      const cli = await listen(cliDb);

      const webResponse = await fetch(`${web.base}/api/web/records/export${query}`, { headers: web.auth });
      const cliResponse = await fetch(`${cli.base}/api/cli/records/export${query}`, { headers: cli.auth });

      expect(cliResponse.status).toBe(webResponse.status);
      expect(await cliResponse.text()).toBe(await webResponse.text());
      expect(cliResponse.headers.get("content-type")).toBe(webResponse.headers.get("content-type"));
      expect(cliResponse.headers.get("content-disposition")).toBe(webResponse.headers.get("content-disposition"));
      expect(cliDb.query.mock.calls[0][1]).toEqual(webDb.query.mock.calls[0][1]);
      expect(cliDb.query.mock.calls[0][0]).toBe(webDb.query.mock.calls[0][0]);
    }
  });
});
