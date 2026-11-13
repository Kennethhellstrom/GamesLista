import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StartDeps, TokenStore, createApp, loadConfig, start } from "../api.js";
import { type Queryable, hashPassword } from "../db.js";

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

function dbWithUser(): Queryable {
  const { hash, salt } = hashPassword("senha-forte");
  return { query: vi.fn(async () => ({ rows: [{ password_hash: hash, salt }] })) };
}

async function listen(db: Queryable, tokens?: TokenStore): Promise<string> {
  const server = createApp(db, tokens).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET / (Web)", () => {
  it("serve o index.html", async () => {
    const base = await listen(dbWithUser());
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("GameList");
  });
});

describe("GET /api/web/health", () => {
  it("responde 200 sem autenticação e sem acessar o banco", async () => {
    const db = dbWithUser();
    const base = await listen(db);
    const response = await fetch(`${base}/api/web/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(db.query).not.toHaveBeenCalled();
    expect(logs()[0]).toMatchObject({ layer: "api", client: "web", operation: "health", status: "success" });
  });
});

describe("POST /api/web/login", () => {
  it("autentica o usuário e devolve um token que a API reconhece", async () => {
    const tokens = new TokenStore();
    const base = await listen(dbWithUser(), tokens);
    const response = await postJson(`${base}/api/web/login`, { username: "admin", password: "senha-forte" });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { token: string };
    expect(data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.validate(data.token)).toEqual({ client: "web" });
  });

  it("gera logs correlacionados (api + db) com request_id req-<guid>, sem expor segredos", async () => {
    const base = await listen(dbWithUser());
    const response = await postJson(`${base}/api/web/login`, { username: "admin", password: "senha-forte" });
    const { token } = (await response.json()) as { token: string };
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^req-[0-9a-f-]{36}$/);
    const entries = logs();
    const api = entries.find((e) => e.layer === "api" && e.operation === "login");
    const db = entries.find((e) => e.layer === "db" && e.operation === "check_credentials");
    expect(api).toMatchObject({ level: "INFO", client: "web", status: "success", request_id: requestId });
    expect(db).toMatchObject({ level: "INFO", client: "web", status: "success", request_id: requestId });
    const everything = output.join("");
    expect(everything).not.toContain("senha-forte");
    expect(everything).not.toContain(token);
  });

  it("responde 401 para senha incorreta e registra WARN", async () => {
    const base = await listen(dbWithUser());
    const response = await postJson(`${base}/api/web/login`, { username: "admin", password: "errada" });
    expect(response.status).toBe(401);
    expect(logs().find((e) => e.layer === "api")).toMatchObject({
      level: "WARN",
      status: "error",
      operation: "login",
    });
    expect(output.join("")).not.toContain("errada");
  });

  it("responde 401 para usuário inexistente", async () => {
    const db: Queryable = { query: vi.fn(async () => ({ rows: [] })) };
    const base = await listen(db);
    const response = await postJson(`${base}/api/web/login`, { username: "ninguem", password: "x" });
    expect(response.status).toBe(401);
  });

  it.each([{}, { username: "admin" }, { password: "x" }, { username: "", password: "" }, { username: 1, password: 2 }])(
    "responde 401 quando as credenciais estão ausentes ou inválidas: %j",
    async (body) => {
      const db = dbWithUser();
      const base = await listen(db);
      const response = await postJson(`${base}/api/web/login`, body);
      expect(response.status).toBe(401);
      expect(db.query).not.toHaveBeenCalled();
    },
  );

  it("responde 401 quando a requisição não tem corpo", async () => {
    const base = await listen(dbWithUser());
    const response = await fetch(`${base}/api/web/login`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("responde 500 e registra ERROR quando o banco falha", async () => {
    const db: Queryable = {
      query: vi.fn(async () => {
        throw new Error("banco fora do ar");
      }),
    };
    const base = await listen(db);
    const response = await postJson(`${base}/api/web/login`, { username: "admin", password: "x" });
    expect(response.status).toBe(500);
    expect(logs().filter((e) => e.level === "ERROR").map((e) => e.layer)).toEqual(["db", "api"]);
  });

  it("responde 400 para JSON malformado, sem vazar detalhes", async () => {
    const base = await listen(dbWithUser());
    const response = await postJson(`${base}/api/web/login`, "{ quebrado");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Requisição inválida" });
  });
});

describe("GET /api/web/me (rota protegida)", () => {
  it("responde 401 sem token", async () => {
    const base = await listen(dbWithUser());
    expect((await fetch(`${base}/api/web/me`)).status).toBe(401);
  });

  it("responde 401 com token desconhecido ou esquema errado", async () => {
    const base = await listen(dbWithUser());
    const bad = await fetch(`${base}/api/web/me`, { headers: { Authorization: "Bearer lixo" } });
    const basic = await fetch(`${base}/api/web/me`, { headers: { Authorization: "Basic abc" } });
    expect(bad.status).toBe(401);
    expect(basic.status).toBe(401);
    expect(logs().some((e) => e.operation === "auth" && e.level === "WARN")).toBe(true);
  });

  it("responde 200 com token válido", async () => {
    const tokens = new TokenStore();
    const base = await listen(dbWithUser(), tokens);
    const token = tokens.issue("web");
    const response = await fetch(`${base}/api/web/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ client: "web" });
  });
});

describe("request_id", () => {
  it("gera um id novo e diferente a cada requisição", async () => {
    const base = await listen(dbWithUser());
    const a = await fetch(`${base}/api/web/health`);
    const b = await fetch(`${base}/api/web/health`);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });
});

describe("TokenStore", () => {
  it("emite tokens aleatórios de 32 bytes e valida só os emitidos", () => {
    const store = new TokenStore();
    const a = store.issue("web");
    const b = store.issue("cli");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(store.validate(a)).toEqual({ client: "web" });
    expect(store.validate(b)).toEqual({ client: "cli" });
    expect(store.validate("desconhecido")).toBeNull();
    expect(store.validate("")).toBeNull();
  });
});

describe("loadConfig", () => {
  const env = {
    DATABASE_URL: "postgres://x",
    GAMESLIST_ADMIN_USER: "admin",
    GAMESLIST_ADMIN_PASSWORD: "p",
  };

  it("lê as variáveis e usa a porta 8080 por padrão", () => {
    expect(loadConfig(env)).toEqual({
      port: 8080,
      databaseUrl: "postgres://x",
      adminUser: "admin",
      adminPassword: "p",
    });
    expect(loadConfig({ ...env, PORT: "4000" }).port).toBe(4000);
  });

  it("falha listando as variáveis ausentes", () => {
    expect(() => loadConfig({ GAMESLIST_ADMIN_USER: "admin" })).toThrow(
      "Variáveis de ambiente ausentes: DATABASE_URL, GAMESLIST_ADMIN_PASSWORD",
    );
  });
});

describe("start", () => {
  it("prepara o banco, cria o usuário inicial e sobe o servidor", async () => {
    const pool: Queryable = { query: vi.fn(async () => ({ rows: [] })) };
    const deps: StartDeps = {
      createPool: vi.fn(() => pool as never),
      initSchema: vi.fn(async () => undefined),
      seedAdminUser: vi.fn(async () => undefined),
    };
    const server = await start(
      { DATABASE_URL: "postgres://x", GAMESLIST_ADMIN_USER: "admin", GAMESLIST_ADMIN_PASSWORD: "p", PORT: "0" },
      deps,
    );
    servers.push(server);
    expect(deps.createPool).toHaveBeenCalledWith("postgres://x");
    expect(deps.initSchema).toHaveBeenCalledWith(pool, "web", "startup");
    expect(deps.seedAdminUser).toHaveBeenCalledWith(pool, "admin", "p", "web", "startup");
    expect(server.listening).toBe(true);
    expect(logs().some((e) => e.operation === "startup" && e.status === "success")).toBe(true);
  });
});
