import { randomBytes } from "node:crypto";
import { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  type ClientKind,
  type Level,
  type Queryable,
  log,
  webCheckCredentials,
} from "./db.js";

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

export interface ApiHandlers {
  health: (client: ClientKind) => RequestHandler;
  webLogin: RequestHandler;
  webMe: RequestHandler;
}

export function createApiHandlers(db: Queryable, tokens: TokenStore): ApiHandlers {
  return {
    health: (client) => (_req, res) => {
      apiLog(res, client, "INFO", "health", "Healthcheck respondido");
      res.status(200).json({ status: "ok" });
    },

    webLogin: async (req, res) => {
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
    },

    webMe: (_req, res) => {
      apiLog(res, "web", "INFO", "me", "Sessão validada");
      res.status(200).json({ client: (res.locals.session as Session).client });
    },
  };
}
