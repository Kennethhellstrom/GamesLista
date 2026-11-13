import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Queryable,
  createPool,
  hashPassword,
  initSchema,
  log,
  run,
  seedAdminUser,
  verifyPassword,
  webCheckCredentials,
} from "../db.js";

const RID = "req-123";

let output: string[] = [];

beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logs(): Record<string, string>[] {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"timestamp"'))
    .map((line) => JSON.parse(line));
}

function fakeDb(rows: unknown[] = []): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rows })) };
}

function failingDb(): Queryable {
  return {
    query: vi.fn(async () => {
      throw new Error("conexão recusada");
    }),
  };
}

describe("log", () => {
  it("escreve uma linha JSON com todos os campos obrigatórios", () => {
    log({
      level: "INFO",
      layer: "db",
      client: "cli",
      operation: "insert",
      status: "success",
      request_id: "req-1",
      message: "ok",
    });
    expect(output).toHaveLength(1);
    expect(output[0]!.endsWith("\n")).toBe(true);
    const entry = logs()[0]!;
    expect(Object.keys(entry)).toEqual([
      "timestamp",
      "level",
      "layer",
      "client",
      "operation",
      "status",
      "request_id",
      "message",
    ]);
    expect(new Date(entry.timestamp!).toISOString()).toBe(entry.timestamp);
    expect(entry).toMatchObject({ level: "INFO", layer: "db", client: "cli", request_id: "req-1" });
  });
});

describe("hashPassword / verifyPassword (PBKDF2)", () => {
  it("não guarda a senha em texto puro e gera salts diferentes", () => {
    const a = hashPassword("segredo");
    const b = hashPassword("segredo");
    expect(a.hash).not.toContain("segredo");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("é determinístico para o mesmo salt", () => {
    expect(hashPassword("segredo", "sal").hash).toBe(hashPassword("segredo", "sal").hash);
  });

  it("aceita a senha correta e rejeita a errada", () => {
    const { hash, salt } = hashPassword("segredo");
    expect(verifyPassword("segredo", hash, salt)).toBe(true);
    expect(verifyPassword("outra", hash, salt)).toBe(false);
  });

  it("rejeita hash ou salt malformado", () => {
    const { hash, salt } = hashPassword("segredo");
    expect(verifyPassword("segredo", "", salt)).toBe(false);
    expect(verifyPassword("segredo", "zz", salt)).toBe(false);
    expect(verifyPassword("segredo", hash, "")).toBe(false);
  });
});

describe("createPool", () => {
  it("cria um pool do pg sem conectar", async () => {
    const pool = createPool("postgres://u:p@localhost:5432/x");
    expect(pool).toBeInstanceOf(pg.Pool);
    await pool.end();
  });
});

describe("run", () => {
  it("devolve as linhas e registra sucesso na camada db com o request_id", async () => {
    const db = fakeDb([{ a: 1 }]);
    await expect(run(db, "cli", RID, "op", "tudo certo", "SELECT 1", [1])).resolves.toEqual([{ a: 1 }]);
    expect(db.query).toHaveBeenCalledWith("SELECT 1", [1]);
    expect(logs()).toEqual([
      expect.objectContaining({
        layer: "db",
        client: "cli",
        level: "INFO",
        status: "success",
        operation: "op",
        request_id: RID,
        message: "tudo certo",
      }),
    ]);
  });

  it("registra ERROR e propaga a falha", async () => {
    await expect(run(failingDb(), "web", RID, "op", "x", "SELECT 1")).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", status: "error", operation: "op", request_id: RID });
  });
});

describe("initSchema", () => {
  it("cria o esquema completo (users e games) e registra um log por tabela", async () => {
    const db = fakeDb();
    await initSchema(db, "web", "startup");
    const [users, games] = db.query.mock.calls.map((call) => String(call[0]));
    expect(users).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(users).toMatch(/username[\s\S]*password_hash[\s\S]*salt/);
    expect(games).toContain("CREATE TABLE IF NOT EXISTS games");
    for (const column of ["id", "title", "platform", "genre", "release_year", "rating", "notes", "active", "created_at"]) {
      expect(games).toContain(column);
    }
    expect(logs().map((e) => e.operation)).toEqual(["create_table_users", "create_table_games"]);
  });

  it("propaga erro do banco", async () => {
    await expect(initSchema(failingDb(), "web", "startup")).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "create_table_users" });
  });
});

describe("seedAdminUser", () => {
  it("persiste o usuário com senha em hash e salt, sem logar a senha", async () => {
    const db = fakeDb();
    await seedAdminUser(db, "admin", "senha-forte", "web", RID);
    const [sql, values] = db.query.mock.calls[0] as [string, string[]];
    expect(sql).toContain("INSERT INTO users");
    expect(sql).toContain("ON CONFLICT (username) DO UPDATE");
    const [username, hash, salt] = values;
    expect(username).toBe("admin");
    expect(hash).not.toBe("senha-forte");
    expect(verifyPassword("senha-forte", hash!, salt!)).toBe(true);
    expect(logs()[0]).toMatchObject({ operation: "seed_user", status: "success", request_id: RID });
    expect(output.join("")).not.toContain("senha-forte");
  });

  it("propaga erro do banco", async () => {
    await expect(seedAdminUser(failingDb(), "admin", "x", "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", operation: "seed_user" });
  });
});

describe("webCheckCredentials", () => {
  const { hash, salt } = hashPassword("senha-forte");
  const row = { password_hash: hash, salt };

  it("retorna true para a senha correta", async () => {
    const db = fakeDb([row]);
    await expect(webCheckCredentials(db, "admin", "senha-forte", "web", RID)).resolves.toBe(true);
    expect(db.query.mock.calls[0]![1]).toEqual(["admin"]);
    expect(logs()[0]).toMatchObject({ operation: "check_credentials", status: "success", client: "web" });
  });

  it("retorna false para senha errada", async () => {
    await expect(webCheckCredentials(fakeDb([row]), "admin", "errada", "web", RID)).resolves.toBe(false);
  });

  it("retorna false quando o usuário não existe", async () => {
    await expect(webCheckCredentials(fakeDb([]), "ninguem", "x", "web", RID)).resolves.toBe(false);
  });

  it("propaga erro do banco e registra ERROR", async () => {
    await expect(webCheckCredentials(failingDb(), "admin", "x", "web", RID)).rejects.toThrow("conexão recusada");
    expect(logs()[0]).toMatchObject({ level: "ERROR", status: "error", operation: "check_credentials" });
  });
});
