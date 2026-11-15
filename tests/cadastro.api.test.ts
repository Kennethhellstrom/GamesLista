import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import type { GameRecord, Queryable } from "../db.js";

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

function gamesDb(initial: GameRecord[] = []): Queryable & { query: ReturnType<typeof vi.fn> } {
  const games = initial.map((game) => ({ ...game, active: 1 }));
  let nextId = games.reduce((highest, game) => Math.max(highest, game.id), 0) + 1;
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("INSERT INTO games")) {
        const [title, platform, genre, release_year, rating, notes] = values;
        const game = {
          id: nextId++,
          title: String(title),
          platform: String(platform),
          genre: String(genre),
          release_year: Number(release_year),
          rating: Number(rating),
          notes: typeof notes === "string" ? notes : null,
          active: 1,
        };
        games.push(game);
        return { rows: [{ id: game.id, title, platform, genre, release_year, rating, notes }] };
      }
      if (text.includes("UPDATE games")) {
        const game = games.find((item) => item.id === values[0] && item.active === 1);
        if (!game) return { rows: [] };
        [game.title, game.platform, game.genre, game.release_year, game.rating, game.notes] = values.slice(1) as [
          string,
          string,
          string,
          number,
          number,
          string | null,
        ];
        const { active: _active, ...updated } = game;
        return { rows: [updated] };
      }
      if (text.includes("COUNT(*)")) return { rows: [{ total: String(games.filter((game) => game.active === 1).length) }] };
      if (text.includes("LIMIT $1 OFFSET $2")) {
        const [, offset] = values as [number, number];
        return {
          rows: games.filter((game) => game.active === 1).slice(offset).map(({ active: _active, ...game }) => game),
        };
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

function record(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hades",
    platform: "PC",
    genre: "RPG",
    release_year: new Date().getFullYear(),
    rating: 9.3,
    notes: "Ótimo jogo",
    ...overrides,
  };
}

describe("formulário Web", () => {
  it("serve os seis campos e o ponto de ação Editar", async () => {
    const { base } = await listen(gamesDb());
    const response = await fetch(`${base}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const field of ["title", "platform", "genre", "release_year", "rating", "notes"]) {
      expect(html).toContain(`name="${field}"`);
    }
    expect(html).toContain("data-edit-game");
    expect(html).toContain("Editar");
  });
});

describe("POST /api/web/records", () => {
  it("normaliza espaços do título e observações vazias para null", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record({ title: "  Hades  ", notes: "" })),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "Hades", notes: null });
  });

  it("persiste um registro, permite lê-lo pela listagem e compartilha request_id nos logs", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ id: 1, title: "Hades", platform: "PC", genre: "RPG", notes: "Ótimo jogo" });

    const listResponse = await fetch(`${base}/api/web/records`, { headers: auth });
    expect((await listResponse.json()).items).toContainEqual(saved);
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((entry) => entry.request_id === requestId).map((entry) => `${entry.layer}:${entry.operation}`))
      .toEqual(["db:insert_record", "api:create_record"]);
  });

  it.each([
    ["title", { title: "" }],
    ["title", { title: "  " }],
    ["title", { title: "x".repeat(101) }],
    ["platform", { platform: "Atari" }],
    ["genre", { genre: "Roguelike" }],
    ["release_year", { release_year: 1969 }],
    ["release_year", { release_year: new Date().getFullYear() + 2 }],
    ["release_year", { release_year: 2020.5 }],
    ["rating", { rating: -0.1 }],
    ["rating", { rating: 10.1 }],
    ["notes", { notes: "x".repeat(501) }],
    ["notes", { notes: 12 }],
  ])("rejeita entrada inválida de %s com erro por campo, sem consultar o banco", async (field, invalid) => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record(invalid)),
    });
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).errors)).toContain(field);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejeita um corpo que não seja objeto", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "[]",
    });
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).errors)).toHaveLength(5);
  });

  it("responde 401 sem token", async () => {
    const db = gamesDb();
    const { base } = await listen(db);
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("registra falha do banco e responde 500", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(500);
    expect(logs().map((entry) => entry.layer)).toEqual(["db", "api"]);
  });
});

describe("PUT /api/web/records/:id", () => {
  it("atualiza registro existente e responde 200 com o registro", async () => {
    const existing = { id: 4, title: "Old", platform: "PC", genre: "RPG", release_year: 2020, rating: 7, notes: null };
    const db = gamesDb([existing]);
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/4`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record({ title: "New title" })),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 4, title: "New title" });
    const listResponse = await fetch(`${base}/api/web/records`, { headers: auth });
    expect((await listResponse.json()).items).toContainEqual(
      expect.objectContaining({ id: 4, title: "New title" }),
    );
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((entry) => entry.request_id === requestId).map((entry) => `${entry.layer}:${entry.operation}`))
      .toEqual(["db:update_record", "api:update_record"]);
  });

  it("responde 404 para id inexistente ou inativo", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/web/records/404`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Jogo não encontrado" });
  });

  it("devolve erros por campo para atualização inválida sem acessar o banco", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/1`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record({ rating: 11 })),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).errors).toHaveProperty("rating");
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(["invalid", "999999999999999999999"])("responde 404 para id inválido (%s) sem acessar o banco", async (id) => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await fetch(`${base}/api/web/records/${id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 401 sem token", async () => {
    const db = gamesDb();
    const { base } = await listen(db);
    const response = await fetch(`${base}/api/web/records/1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("registra falha do banco e responde 500", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await fetch(`${base}/api/web/records/1`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(record()),
    });
    expect(response.status).toBe(500);
    expect(logs().map((entry) => entry.layer)).toEqual(["db", "api"]);
  });
});
