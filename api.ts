import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { TokenStore, apiLog, createApiHandlers, requestIdOf, requireAuth } from "./api.handler.js";
import {
  type Queryable,
  createPool,
  initSchema,
  isSortField,
  log,
  seedAdminUser,
  seedGames,
  webCountRecords,
  webCountSearchRecords,
  webDeleteRecord,
  webListRecords,
  webSearchRecords,
} from "./db.js";

export { type Session, TokenStore, apiLog, requestIdOf, requireAuth } from "./api.handler.js";

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
  const handlers = createApiHandlers(db, tokens);

  // ===== #1 inicio: estrutura web =====

  // A página inicial (Web) é servida pela própria API.
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(INDEX_PATH);
  });

  // Healthcheck público: não acessa o banco.
  app.get("/api/web/health", handlers.health("web"));

  app.post("/api/web/login", handlers.webLogin);

  // Rota protegida: a página inicial usa para validar a sessão ao abrir.
  app.get("/api/web/me", auth, handlers.webMe);

  // ===== #1 fim =====

  // ===== #2 inicio: cadastro/edição web (B) =====
  // ===== #2 fim =====

  // ===== #3 inicio: listagem/exclusão web (C) =====

  const DEFAULT_PAGE_SIZE = 5;
  const MAX_PAGE_SIZE = 100;

  /** Lê um inteiro positivo da query/rota; `undefined` usa o padrão e `null` indica valor inválido. */
  const positiveInt = (value: unknown, fallback: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) return null;
    return Number(value);
  };

  app.get("/api/web/records", auth, async (req: Request, res: Response) => {
    const page = positiveInt(req.query.page, 1);
    const pageSize = positiveInt(req.query.page_size, DEFAULT_PAGE_SIZE);
    const sort = req.query.sort ?? "id";
    const order = req.query.order ?? "asc";
    if (
      page === null ||
      pageSize === null ||
      pageSize > MAX_PAGE_SIZE ||
      !isSortField(sort) ||
      (order !== "asc" && order !== "desc")
    ) {
      apiLog(res, "web", "WARN", "list_records", "Parâmetros de listagem inválidos");
      res.status(400).json({ error: "Parâmetros inválidos" });
      return;
    }
    try {
      const requestId = requestIdOf(res);
      const items = await webListRecords(db, { page, pageSize, sort, order }, "web", requestId);
      const total = await webCountRecords(db, "web", requestId);
      apiLog(res, "web", "INFO", "list_records", `Listagem devolvida (página ${page})`);
      res.status(200).json({ items, page, page_size: pageSize, total });
    } catch {
      apiLog(res, "web", "ERROR", "list_records", "Erro interno ao listar jogos");
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Exclusão lógica: o jogo passa a inativo; id inexistente ou já excluído responde 404.
  app.delete("/api/web/records/:id", auth, async (req: Request, res: Response) => {
    const id = positiveInt(req.params.id, 0);
    if (id === null || id === 0) {
      apiLog(res, "web", "WARN", "delete_record", "Identificador inválido");
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }
    try {
      const deleted = await webDeleteRecord(db, id, "web", requestIdOf(res));
      if (!deleted) {
        apiLog(res, "web", "WARN", "delete_record", "Jogo não encontrado");
        res.status(404).json({ error: "Jogo não encontrado" });
        return;
      }
      apiLog(res, "web", "INFO", "delete_record", "Jogo excluído");
      res.status(204).end();
    } catch {
      apiLog(res, "web", "ERROR", "delete_record", "Erro interno ao excluir jogo");
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // ===== #3 fim =====

  // ===== #4 inicio: busca web (C) =====

  const MAX_TEXT_FILTER = 100;

  /** Filtro de texto: ausente ou vazio vira `undefined`; repetido ou longo demais vira `null` (inválido). */
  const textFilter = (value: unknown): string | undefined | null => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > MAX_TEXT_FILTER) return null;
    return value.trim() || undefined;
  };

  /** Filtro de ano: inteiro positivo; ausente ou vazio vira `undefined` e valor inválido vira `null`. */
  const yearFilter = (value: unknown): number | undefined | null =>
    value === undefined || value === "" ? undefined : positiveInt(value, 0);

  /** Nota mínima: decimal de 0 a 10 (ex.: 8 ou 8.5); ausente ou vazia vira `undefined`, inválida vira `null`. */
  const ratingFilter = (value: unknown): number | undefined | null => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || !/^\d{1,2}(\.\d{1,2})?$/.test(value)) return null;
    const rating = Number(value);
    return rating <= 10 ? rating : null;
  };

  // Mesmo formato de resposta da listagem; só devolve jogos ativos que atendem a TODOS os filtros enviados.
  app.get("/api/web/records/search", auth, async (req: Request, res: Response) => {
    const page = positiveInt(req.query.page, 1);
    const pageSize = positiveInt(req.query.page_size, DEFAULT_PAGE_SIZE);
    const sort = req.query.sort ?? "id";
    const order = req.query.order ?? "asc";
    const q = textFilter(req.query.q);
    const platform = textFilter(req.query.platform);
    const genre = textFilter(req.query.genre);
    const yearMin = yearFilter(req.query.year_min);
    const yearMax = yearFilter(req.query.year_max);
    const ratingMin = ratingFilter(req.query.rating_min);
    if (
      page === null ||
      pageSize === null ||
      pageSize > MAX_PAGE_SIZE ||
      !isSortField(sort) ||
      (order !== "asc" && order !== "desc") ||
      q === null ||
      platform === null ||
      genre === null ||
      yearMin === null ||
      yearMax === null ||
      ratingMin === null
    ) {
      apiLog(res, "web", "WARN", "search_records", "Parâmetros de busca inválidos");
      res.status(400).json({ error: "Parâmetros inválidos" });
      return;
    }
    try {
      const requestId = requestIdOf(res);
      const filters = { q, platform, genre, yearMin, yearMax, ratingMin };
      const items = await webSearchRecords(db, { ...filters, page, pageSize, sort, order }, "web", requestId);
      const total = await webCountSearchRecords(db, filters, "web", requestId);
      apiLog(res, "web", "INFO", "search_records", `Busca devolvida (página ${page})`);
      res.status(200).json({ items, page, page_size: pageSize, total });
    } catch {
      apiLog(res, "web", "ERROR", "search_records", "Erro interno ao buscar jogos");
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // ===== #4 fim =====

  // ===== #5 inicio: exportação CSV web (A) =====
  // ===== #5 fim =====

  // ===== #6 inicio: dashboard web (A) =====
  // ===== #6 fim =====

  // ===== #7 inicio: estrutura CLI (B) =====
  app.get("/api/cli/health", handlers.health("cli"));
  app.post("/api/cli/token", handlers.cliToken);
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
  seedGames: typeof seedGames;
}

const defaultDeps: StartDeps = { createPool, initSchema, seedAdminUser, seedGames };

export async function start(env: NodeJS.ProcessEnv, deps: StartDeps = defaultDeps): Promise<Server> {
  const config = loadConfig(env);
  const pool = deps.createPool(config.databaseUrl);
  await deps.initSchema(pool, "web", "startup");
  await deps.seedAdminUser(pool, config.adminUser, config.adminPassword, "web", "startup");
  // #3: jogos de exemplo só com GAMESLIST_SEED=true (e só se a tabela estiver vazia).
  if (env.GAMESLIST_SEED === "true") await deps.seedGames(pool, "web", "startup");
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
