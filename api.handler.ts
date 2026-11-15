import { randomBytes } from "node:crypto";
import { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  type ClientKind,
  type GameRecord,
  type GameRecordInput,
  type Level,
  type Queryable,
  log,
  webCheckCredentials,
  webInsertRecord,
  webUpdateRecord,
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
  cliToken: RequestHandler;
  webLogin: RequestHandler;
  webMe: RequestHandler;
  webCreateRecord: RequestHandler;
  webUpdateRecord: RequestHandler;
}

const PLATFORMS = ["PC", "PlayStation", "Xbox", "Switch", "Mobile", "Outro"] as const;
const GENRES = ["Ação", "Aventura", "RPG", "Estratégia", "Esporte", "Corrida", "Puzzle", "Outro"] as const;
const PLATFORM_SET: ReadonlySet<string> = new Set(PLATFORMS);
const GENRE_SET: ReadonlySet<string> = new Set(GENRES);
type RecordField = keyof GameRecordInput;
type RecordErrors = Partial<Record<RecordField, string>>;

export function validateRecord(input: unknown): { value: GameRecordInput | null; errors: RecordErrors } {
  const body: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const errors: RecordErrors = {};

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 1 || title.length > 100) errors.title = "Informe um título de 1 a 100 caracteres.";

  const platform = typeof body.platform === "string" ? body.platform : "";
  if (!PLATFORM_SET.has(platform)) errors.platform = "Selecione uma plataforma válida.";

  const genre = typeof body.genre === "string" ? body.genre : "";
  if (!GENRE_SET.has(genre)) errors.genre = "Selecione um gênero válido.";

  const releaseYear = typeof body.release_year === "number" ? body.release_year : Number.NaN;
  const maxReleaseYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(releaseYear) || releaseYear < 1970 || releaseYear > maxReleaseYear) {
    errors.release_year = `Informe um ano inteiro entre 1970 e ${maxReleaseYear}.`;
  }

  const rating = typeof body.rating === "number" ? body.rating : Number.NaN;
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
    errors.rating = "Informe uma nota de 0 a 10.";
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null && body.notes !== "") {
    if (typeof body.notes !== "string" || body.notes.length > 500) {
      errors.notes = "As observações devem ter no máximo 500 caracteres.";
    } else {
      notes = body.notes;
    }
  }

  if (Object.keys(errors).length > 0) return { value: null, errors };
  return {
    value: {
      title,
      platform,
      genre,
      release_year: releaseYear,
      rating,
      notes,
    },
    errors,
  };
}

function recordId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function createApiHandlers(db: Queryable, tokens: TokenStore): ApiHandlers {
  return {
    health: (client) => (_req, res) => {
      apiLog(res, client, "INFO", "health", "Healthcheck respondido");
      res.status(200).json({ status: "ok" });
    },

    cliToken: (req, res) => {
      const { token } = (req.body ?? {}) as { token?: unknown };
      if (typeof token !== "string" || token.length === 0) {
        apiLog(res, "cli", "WARN", "token", "Token ausente");
        res.status(401).json({ error: "Token não informado" });
        return;
      }

      if (!tokens.validate(token)) {
        apiLog(res, "cli", "WARN", "token", "Token inválido");
        res.status(401).json({ error: "Token inválido" });
        return;
      }

      apiLog(res, "cli", "INFO", "token", "Token informado");
      res.status(200).json({ message: "Token válido" });
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

    webCreateRecord: async (req, res) => {
      const { value, errors } = validateRecord(req.body);
      if (!value) {
        apiLog(res, "web", "WARN", "create_record", "Dados do jogo inválidos");
        res.status(400).json({ errors });
        return;
      }
      try {
        const record = await webInsertRecord(db, value, "web", requestIdOf(res));
        if (!record) throw new Error("O banco não devolveu o jogo cadastrado");
        apiLog(res, "web", "INFO", "create_record", "Jogo cadastrado");
        res.status(200).json(record);
      } catch {
        apiLog(res, "web", "ERROR", "create_record", "Erro interno ao cadastrar jogo");
        res.status(500).json({ error: "Erro interno" });
      }
    },

    webUpdateRecord: async (req, res) => {
      const id = recordId(req.params.id);
      if (id === null) {
        apiLog(res, "web", "WARN", "update_record", "Jogo não encontrado");
        res.status(404).json({ error: "Jogo não encontrado" });
        return;
      }
      const { value, errors } = validateRecord(req.body);
      if (!value) {
        apiLog(res, "web", "WARN", "update_record", "Dados do jogo inválidos");
        res.status(400).json({ errors });
        return;
      }
      try {
        const record = await webUpdateRecord(db, id, value, "web", requestIdOf(res));
        if (!record) {
          apiLog(res, "web", "WARN", "update_record", "Jogo não encontrado");
          res.status(404).json({ error: "Jogo não encontrado" });
          return;
        }
        apiLog(res, "web", "INFO", "update_record", "Jogo atualizado");
        res.status(200).json(record);
      } catch {
        apiLog(res, "web", "ERROR", "update_record", "Erro interno ao atualizar jogo");
        res.status(500).json({ error: "Erro interno" });
      }
    },
  };
}
