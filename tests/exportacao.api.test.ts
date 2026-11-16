import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { Queryable } from "../db.js";

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
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

type FakeDb = Queryable & { query: ReturnType<typeof vi.fn> };

function gamesDb(rows: unknown[] = []): FakeDb {
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
  return { base, auth: { Authorization: `Bearer ${tokens.issue("web")}` } };
}

describe("GET /api/web/records/export", () => {
  it("exporta todos os resultados, mesmo além do tamanho de página, sem filtros", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      title: `Jogo ${index + 1}`,
      platform: "PC",
      genre: "RPG",
      release_year: 2020,
      rating: 8,
      notes: null,
      active: 1,
    }));
    const db = gamesDb(rows);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="games.csv"');
    expect(csv.split("\r\n")).toHaveLength(8);
    expect(csv.startsWith('"id","title","platform","genre","release_year","rating","notes","active"\r\n')).toBe(true);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual([]);
  });

  it("aplica todos os filtros fornecidos sem paginação", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(
      `${base}/api/web/records/export?q=zelda&platform=Switch&genre=RPG&year_min=2018&year_max=2024&rating_min=8.5`,
      { headers: auth },
    );

    expect(response.status).toBe(200);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LOWER(title) LIKE");
    expect(sql).toContain("LOWER(platform)");
    expect(sql).toContain("LOWER(genre)");
    expect(sql).toContain("release_year >= $4");
    expect(sql).toContain("release_year <= $5");
    expect(sql).toContain("rating >= $6");
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    expect(values).toEqual(["zelda", "Switch", "RPG", 2018, 2024, 8.5]);
  });

  it("escapa valores CSV e neutraliza fórmulas em campos textuais", async () => {
    const db = gamesDb([
      {
        id: 1,
        title: "=1+1",
        platform: "PC",
        genre: "Ação",
        release_year: 2020,
        rating: 9.5,
        notes: '  =1+1, "texto"\r\nnova linha',
        active: 1,
      },
      {
        id: 2,
        title: "\t@SUM(A1:A2)",
        platform: "PC",
        genre: "Ação",
        release_year: 2021,
        rating: 8,
        notes: null,
        active: 1,
      },
    ]);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });

    expect(await response.text()).toBe(
      [
        '"id","title","platform","genre","release_year","rating","notes","active"',
        '"1","\'=1+1","PC","Ação","2020","9.5","\'  =1+1, ""texto""\r\nnova linha","1"',
        '"2","\'\t@SUM(A1:A2)","PC","Ação","2021","8","","1"',
      ].join("\r\n"),
    );
  });

  it("rejeita filtros inválidos sem consultar o banco", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/export?q=a&q=b`, { headers: auth });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Parâmetros inválidos" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs()).toContainEqual(expect.objectContaining({
      layer: "api",
      operation: "export_records",
      level: "WARN",
    }));
  });

  it("exige token Bearer válido e não acessa o banco sem autenticação", async () => {
    const db = gamesDb();
    const { base } = await listen(db);

    expect((await fetch(`${base}/api/web/records/export`)).status).toBe(401);
    expect((await fetch(`${base}/api/web/records/export`, {
      headers: { Authorization: "Bearer inválido" },
    })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("correlaciona os logs api e db com o mesmo request_id", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });
    const requestId = response.headers.get("x-request-id");
    const entries = logs().filter((entry) => entry.request_id === requestId);

    expect(entries.map((entry) => `${entry.layer}:${entry.operation}:${entry.level}`)).toEqual([
      "db:export_records:INFO",
      "api:export_records:INFO",
    ]);
  });

  it("responde 500 e registra erro quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records/export`, { headers: auth });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((entry) => entry.level === "ERROR").map((entry) => `${entry.layer}:${entry.operation}`))
      .toEqual(["db:export_records", "api:export_records"]);
  });
});
