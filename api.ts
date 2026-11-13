import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  type ClientKind,
  type Level,
  type Queryable,
  createPool,
  initSchema,
  log,
  seedAdminUser,
  webCheckCredentials,
} from "./db.js";

// ===========================================================================
// Convenções da equipe (ver README e o guia comum)
// - Rotas da Web ficam em /api/web/*, as da CLI em /api/cli/*, com SQL próprio em db.ts.
// - Rotas protegidas usam `requireAuth(tokens)`; sem token válido, HTTP 401.
// - Use `apiLog(res, client, level, operation, message)` para a linha de log da API.
// - Cada issue escreve SOMENTE dentro do seu bloco "===== #N inicio/fim =====".
// ===========================================================================

// ---------------------------------------------------------------------------
// Configuração (tudo por variáveis de ambiente; nada de segredo no código)
// ---------------------------------------------------------------------------

export interface Config {
  port: number;
  databaseUrl: string;
  adminUser: string;
  adminPassword: string;
}

const REQUIRED_ENV = ["DATABASE_URL", "GAMESLIST_ADMIN_USER", "GAMESLIST_ADMIN_PASSWORD"] as const;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Variáveis de ambiente ausentes: ${missing.join(", ")}`);
  }
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL as string,
    adminUser: env.GAMESLIST_ADMIN_USER as string,
    adminPassword: env.GAMESLIST_ADMIN_PASSWORD as string,
  };
}

// ---------------------------------------------------------------------------
// Tokens de sessão (contrato interno reutilizado por Web e CLI)
// ---------------------------------------------------------------------------

export interface Session {
  client: ClientKind;
}

/** Guarda em memória os tokens emitidos (32 bytes aleatórios). */
export class TokenStore {
  private readonly sessions = new Map<string, Session>();

  issue(client: ClientKind): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { client });
    return token;
  }

  validate(token: string): Session | null {
    return this.sessions.get(token) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers compartilhados
// ---------------------------------------------------------------------------

export function requestIdOf(res: Response): string {
  return res.locals.requestId as string;
}

export function apiLog(res: Response, client: ClientKind, level: Level, operation: string, message: string): void {
  log({
    level,
    layer: "api",
    client,
    operation,
    status: level === "INFO" ? "success" : "error",
    request_id: requestIdOf(res),
    message,
  });
}

/** Filtro de autenticação: exige `Authorization: Bearer <token>` válido, senão HTTP 401. */
export function requireAuth(tokens: TokenStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = tokens.validate(token);
    if (!session) {
      apiLog(res, "web", "WARN", "auth", "Token ausente ou inválido");
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    res.locals.session = session;
    next();
  };
}

// ---------------------------------------------------------------------------
// Aplicação HTTP
// ---------------------------------------------------------------------------

const INDEX_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export function createApp(db: Queryable, tokens: TokenStore = new TokenStore()): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Cada requisição recebe um request_id (req-<guid>), repassado às camadas api e db.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = `req-${randomUUID()}`;
    res.setHeader("X-Request-Id", requestIdOf(res));
    next();
  });

  app.use(express.json());

  const auth = requireAuth(tokens);

  // ===== #1 inicio: estrutura web =====

  // A página inicial (Web) é servida pela própria API.
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(INDEX_PATH);
  });

  // Healthcheck público: não acessa o banco.
  app.get("/api/web/health", (_req: Request, res: Response) => {
    apiLog(res, "web", "INFO", "health", "Healthcheck respondido");
    res.status(200).json({ status: "ok" });
  });

  app.post("/api/web/login", async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      apiLog(res, "web", "WARN", "login", "Falha de autenticação: credenciais ausentes");
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }
    try {
      const valid = await webCheckCredentials(db, username, password, "web", requestIdOf(res));
      if (!valid) {
        apiLog(res, "web", "WARN", "login", "Falha de autenticação: credenciais inválidas");
        res.status(401).json({ error: "Credenciais inválidas" });
        return;
      }
      const token = tokens.issue("web");
      apiLog(res, "web", "INFO", "login", "Login realizado com sucesso");
      res.status(200).json({ token });
    } catch {
      apiLog(res, "web", "ERROR", "login", "Erro interno ao autenticar");
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Rota protegida: a página inicial usa para validar a sessão ao abrir.
  app.get("/api/web/me", auth, (_req: Request, res: Response) => {
    apiLog(res, "web", "INFO", "me", "Sessão validada");
    res.status(200).json({ client: (res.locals.session as Session).client });
  });

  // ===== #1 fim =====

  // ===== #2 inicio: cadastro/edição web (B) =====
  // ===== #2 fim =====

  // ===== #3 inicio: listagem/exclusão web (C) =====
  // ===== #3 fim =====

  // ===== #4 inicio: busca web (C) =====
  // ===== #4 fim =====

  // ===== #5 inicio: exportação CSV web (A) =====
  // ===== #5 fim =====

  // ===== #6 inicio: dashboard web (A) =====
  // ===== #6 fim =====

  // ===== #7 inicio: estrutura CLI (B) =====
  // ===== #7 fim =====

  // ===== #8 inicio: cadastro/edição CLI (A) =====
  // ===== #8 fim =====

  // ===== #9 inicio: listagem/exclusão CLI (C) =====
  // ===== #9 fim =====

  // ===== #10 inicio: busca CLI (B) =====
  // ===== #10 fim =====

  // ===== #11 inicio: exportação CSV CLI (C) =====
  // ===== #11 fim =====

  // ===== #12 inicio: indicadores CLI (B) =====
  // ===== #12 fim =====

  // Erros inesperados (ex.: JSON malformado) viram respostas JSON, sem vazar detalhes.
  // Mantenha este tratador DEPOIS de todos os blocos.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    apiLog(res, "web", status < 500 ? "WARN" : "ERROR", "request", `Requisição rejeitada (HTTP ${status})`);
    res.status(status).json({ error: status < 500 ? "Requisição inválida" : "Erro interno" });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

export interface StartDeps {
  createPool: typeof createPool;
  initSchema: typeof initSchema;
  seedAdminUser: typeof seedAdminUser;
}

const defaultDeps: StartDeps = { createPool, initSchema, seedAdminUser };

export async function start(env: NodeJS.ProcessEnv, deps: StartDeps = defaultDeps): Promise<Server> {
  const config = loadConfig(env);
  const pool = deps.createPool(config.databaseUrl);
  await deps.initSchema(pool, "web", "startup");
  await deps.seedAdminUser(pool, config.adminUser, config.adminPassword, "web", "startup");
  const app = createApp(pool);
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      log({
        level: "INFO",
        layer: "api",
        client: "web",
        operation: "startup",
        status: "success",
        request_id: "startup",
        message: "API iniciada",
      });
      resolve(server);
    });
  });
}

// Só sobe o servidor quando executado diretamente (`npm start`), não ao importar nos testes.
if (process.argv[1] === fileURLToPath(import.meta.url)) void start(process.env);
