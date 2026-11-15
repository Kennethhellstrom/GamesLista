import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, createApp } from "../api.js";
import { run } from "../cli.js";
import type { GameRecord, Queryable } from "../db.js";

// Testes da issue #8 (rotas POST /api/cli/records e PUT /api/cli/records/:id).

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

/** Banco falso com estado: guarda os jogos para criar, editar e listar de volta (como faz a Web). */
function gamesDb(initial: GameRecord[] = []): FakeDb {
  const games = initial.map((game) => ({ ...game, active: 1 }));
  let nextId = games.reduce((max, game) => Math.max(max, game.id), 0) + 1;
  const visible = () => games.filter((g) => g.active === 1).map(({ active: _active, ...game }) => game);
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("INSERT INTO games")) {
        const [title, platform, genre, release_year, rating, notes] = values as [
          string, string, string, number, number, string | null,
        ];
        const game = { id: nextId++, title, platform, genre, release_year, rating, notes, active: 1 };
        games.push(game);
        const { active: _active, ...created } = game;
        return { rows: [created] };
      }
      if (text.includes("UPDATE games")) {
        const game = games.find((g) => g.id === values[0] && g.active === 1);
        if (!game) return { rows: [] };
        [game.title, game.platform, game.genre, game.release_year, game.rating, game.notes] = values.slice(1) as [
          string, string, string, number, number, string | null,
        ];
        const { active: _active, ...updated } = game;
        return { rows: [updated] };
      }
      if (text.includes("COUNT(*)")) return { rows: [{ total: String(visible().length) }] };
      if (text.includes("LIMIT")) return { rows: visible() };
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

async function listen(db: Queryable): Promise<{ base: string; token: string; auth: Record<string, string> }> {
  const tokens = new TokenStore();
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const token = tokens.issue("web");
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    auth: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

const VALID = { title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3, notes: "Roguelike" };
const EXISTING: GameRecord = {
  id: 7,
  title: "Portal 2",
  platform: "PC",
  genre: "Puzzle",
  release_year: 2011,
  rating: 9.5,
  notes: null,
};

function send(base: string, method: string, path: string, headers: Record<string, string>, body: unknown) {
  return fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
}

describe("POST /api/cli/records", () => {
  it("cria um jogo válido, devolve o registro persistido e correlaciona os logs api e db da CLI", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await send(base, "POST", "/api/cli/records", auth, { ...VALID, title: "  Hades  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1, ...VALID });
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((e) => e.request_id === requestId).map((e) => `${e.layer}:${e.client}:${e.operation}:${e.level}`)).toEqual([
      "db:cli:cli_insert_record:INFO",
      "api:cli:cli_create_record:INFO",
    ]);
  });

  it("persiste: o jogo criado pela CLI aparece na listagem da Web", async () => {
    const { base, auth } = await listen(gamesDb([EXISTING]));
    await send(base, "POST", "/api/cli/records", auth, VALID);
    const list = await fetch(`${base}/api/web/records`, { headers: auth });
    const data = (await list.json()) as { items: GameRecord[]; total: number };
    expect(data.total).toBe(2);
    expect(data.items).toContainEqual({ id: 8, ...VALID });
  });

  it("cria sem observações (notes vira null)", async () => {
    const { base, auth } = await listen(gamesDb());
    const { notes: _notes, ...withoutNotes } = VALID;
    const response = await send(base, "POST", "/api/cli/records", auth, withoutNotes);
    expect(await response.json()).toMatchObject({ notes: null });
  });

  it("responde 400 com os erros por campo (mesmas mensagens da Web), sem chegar ao banco", async () => {
    const db = gamesDb();
    const { base, auth } = await listen(db);
    const response = await send(base, "POST", "/api/cli/records", auth, {
      title: "",
      platform: "Atari",
      genre: "Tiro",
      release_year: 1960,
      rating: 11,
      notes: "x".repeat(501),
    });
    expect(response.status).toBe(400);
    const { errors } = (await response.json()) as { errors: Record<string, string> };
    expect(Object.keys(errors).sort()).toEqual(["genre", "notes", "platform", "rating", "release_year", "title"]);
    expect(errors.title).toBe("Informe um título de 1 a 100 caracteres.");
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().find((e) => e.layer === "api")).toMatchObject({ level: "WARN", client: "cli", operation: "cli_create_record" });
  });

  it("responde 400 quando o corpo está vazio", async () => {
    const { base, auth } = await listen(gamesDb());
    const response = await fetch(`${base}/api/cli/records`, { method: "POST", headers: { Authorization: auth.Authorization } });
    expect(response.status).toBe(400);
    expect(Object.keys(((await response.json()) as { errors: object }).errors)).toHaveLength(5);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await send(base, "POST", "/api/cli/records", auth, VALID);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erro interno" });
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.client}`)).toEqual(["db:cli", "api:cli"]);
  });
});

describe("PUT /api/cli/records/:id", () => {
  it("edita um jogo existente e a Web passa a ver os dados novos", async () => {
    const db = gamesDb([EXISTING]);
    const { base, auth } = await listen(db);
    const response = await send(base, "PUT", "/api/cli/records/7", auth, { ...VALID, title: "Portal 2 (edição)" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 7, ...VALID, title: "Portal 2 (edição)" });
    const requestId = response.headers.get("x-request-id");
    expect(logs().filter((e) => e.request_id === requestId).map((e) => `${e.layer}:${e.client}:${e.operation}`)).toEqual([
      "db:cli:cli_update_record",
      "api:cli:cli_update_record",
    ]);

    const list = (await (await fetch(`${base}/api/web/records`, { headers: auth })).json()) as { items: GameRecord[] };
    expect(list.items).toEqual([{ id: 7, ...VALID, title: "Portal 2 (edição)" }]);
  });

  it("responde 404 quando o id não existe ou foi excluído", async () => {
    const { base, auth } = await listen(gamesDb([EXISTING]));
    const response = await send(base, "PUT", "/api/cli/records/999", auth, VALID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Jogo não encontrado" });
    expect(logs().find((e) => e.layer === "api")).toMatchObject({ level: "WARN", client: "cli", operation: "cli_update_record" });
  });

  it.each(["abc", "0", "-3", "1.5"])("responde 404 para id inválido (%s) sem acessar o banco", async (id) => {
    const db = gamesDb([EXISTING]);
    const { base, auth } = await listen(db);
    const response = await send(base, "PUT", `/api/cli/records/${id}`, auth, VALID);
    expect(response.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 400 com os erros por campo, sem chegar ao banco", async () => {
    const db = gamesDb([EXISTING]);
    const { base, auth } = await listen(db);
    const response = await send(base, "PUT", "/api/cli/records/7", auth, { ...VALID, rating: "nove" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { rating: "Informe uma nota de 0 a 10." } });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const { base, auth } = await listen(failingDb());
    const response = await send(base, "PUT", "/api/cli/records/7", auth, VALID);
    expect(response.status).toBe(500);
    expect(logs().filter((e) => e.level === "ERROR").map((e) => `${e.layer}:${e.operation}`)).toEqual([
      "db:cli_update_record",
      "api:cli_update_record",
    ]);
  });
});

describe("autenticação das rotas da CLI", () => {
  it.each([
    ["POST", "/api/cli/records"],
    ["PUT", "/api/cli/records/7"],
  ])("%s %s responde 401 sem token, com token inválido ou com esquema errado", async (method, path) => {
    const db = gamesDb([EXISTING]);
    const { base } = await listen(db);
    const json = { "Content-Type": "application/json" };
    for (const headers of [json, { ...json, Authorization: "Bearer invalido" }, { ...json, Authorization: "Basic abc" }]) {
      const response = await send(base, method, path, headers, VALID);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Não autenticado" });
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(logs().filter((e) => e.operation === "auth").every((e) => e.client === "cli" && e.level === "WARN")).toBe(true);
  });
});

describe("CLI de ponta a ponta (add/edit contra a API)", () => {
  it("cadastra e edita pela CLI e os dados aparecem na listagem da Web", async () => {
    const { base, token, auth } = await listen(gamesDb());
    const env = { GAMESLIST_API_URL: base, GAMESLIST_TOKEN: token };
    const cliOutput = vi.fn();
    const fields = ["--platform", "PC", "--genre", "Outro", "--year", "2020", "--rating", "9,3"];

    expect(await run(["add", "--title", "Hades", ...fields], fetch, cliOutput, env)).toBe(0);
    expect(cliOutput).toHaveBeenLastCalledWith("Jogo cadastrado (HTTP 200): #1 Hades | PC | Outro | 2020 | nota 9.3");

    expect(await run(["edit", "1", "--title", "Hades II", ...fields, "--notes", "Sequência"], fetch, cliOutput, env)).toBe(0);
    expect(cliOutput).toHaveBeenLastCalledWith(
      "Jogo atualizado (HTTP 200): #1 Hades II | PC | Outro | 2020 | nota 9.3 | Sequência",
    );

    const list = (await (await fetch(`${base}/api/web/records`, { headers: auth })).json()) as { items: GameRecord[] };
    expect(list.items).toEqual([
      { id: 1, title: "Hades II", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3, notes: "Sequência" },
    ]);
    expect(cliOutput.mock.calls.flat().join("")).not.toContain(token);
    expect(output.join("")).not.toContain(token);
  });
});
