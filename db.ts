import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";

// ===========================================================================
// Convenções da equipe (ver README e o guia comum)
// - Métodos da Web começam com `web`, os da CLI com `cli`, cada um com SQL próprio.
// - Todo método recebe `(client, requestId)` por último e registra a própria linha
//   de log da camada `db`, inclusive em leituras.
// - Cada issue escreve SOMENTE dentro do seu bloco "===== #N inicio/fim =====".
// ===========================================================================

// ---------------------------------------------------------------------------
// Logger (uma linha JSON por evento no stdout)
// ---------------------------------------------------------------------------

export type Level = "INFO" | "WARN" | "ERROR";
export type Layer = "api" | "db";
export type ClientKind = "web" | "cli";

export interface LogEvent {
  level: Level;
  layer: Layer;
  client: ClientKind;
  operation: string;
  status: "success" | "error";
  request_id: string;
  message: string;
}

/** Escreve um evento de log como uma linha JSON. Nunca recebe senhas, tokens ou segredos. */
export function log(event: LogEvent): void {
  const line = {
    timestamp: new Date().toISOString(),
    level: event.level,
    layer: event.layer,
    client: event.client,
    operation: event.operation,
    status: event.status,
    request_id: event.request_id,
    message: event.message,
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}

// ---------------------------------------------------------------------------
// Senhas (PBKDF2-SHA256 com salt aleatório; nada em texto puro)
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 210_000;

export function hashPassword(
  password: string,
  salt: string = randomBytes(16).toString("hex"),
): { hash: string; salt: string } {
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const expected = Buffer.from(hash, "hex");
  if (!salt || expected.length === 0) return false;
  const actual = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, expected.length, "sha256");
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Acesso ao banco
// ---------------------------------------------------------------------------

/** O mínimo que precisamos de um pool: facilita os testes unitários. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

function dbLog(
  client: ClientKind,
  requestId: string,
  operation: string,
  status: "success" | "error",
  message: string,
): void {
  log({
    level: status === "success" ? "INFO" : "ERROR",
    layer: "db",
    client,
    operation,
    status,
    request_id: requestId,
    message,
  });
}

/** Executa a consulta registrando o resultado na camada `db`. Use em todos os métodos. */
export async function run(
  db: Queryable,
  client: ClientKind,
  requestId: string,
  operation: string,
  okMessage: string,
  text: string,
  values?: unknown[],
): Promise<unknown[]> {
  try {
    const result = await db.query(text, values);
    dbLog(client, requestId, operation, "success", okMessage);
    return result.rows;
  } catch (error) {
    dbLog(client, requestId, operation, "error", `Falha na operação ${operation}`);
    throw error;
  }
}

// ===== #1 inicio: estrutura (esquema completo, usuário inicial, login web) =====

/** Cria o esquema COMPLETO (users e games) para ninguém mexer em esquema depois. */
export async function initSchema(db: Queryable, client: ClientKind, requestId: string): Promise<void> {
  await run(
    db,
    client,
    requestId,
    "create_table_users",
    "Tabela users pronta",
    `CREATE TABLE IF NOT EXISTS users (
       username TEXT PRIMARY KEY,
       password_hash TEXT NOT NULL,
       salt TEXT NOT NULL
     )`,
  );
  await run(
    db,
    client,
    requestId,
    "create_table_games",
    "Tabela games pronta",
    `CREATE TABLE IF NOT EXISTS games (
       id SERIAL PRIMARY KEY,
       title TEXT NOT NULL,
       platform TEXT NOT NULL,
       genre TEXT NOT NULL,
       release_year INTEGER NOT NULL,
       rating DOUBLE PRECISION NOT NULL,
       notes TEXT,
       active INTEGER NOT NULL DEFAULT 1,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Cria (ou atualiza a senha de) o usuário inicial configurado por variáveis de ambiente. */
export async function seedAdminUser(
  db: Queryable,
  username: string,
  password: string,
  client: ClientKind,
  requestId: string,
): Promise<void> {
  const { hash, salt } = hashPassword(password);
  await run(
    db,
    client,
    requestId,
    "seed_user",
    "Usuário inicial persistido",
    `INSERT INTO users (username, password_hash, salt) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt`,
    [username, hash, salt],
  );
}

/** Confere usuário e senha para o login da Web. */
export async function webCheckCredentials(
  db: Queryable,
  username: string,
  password: string,
  client: ClientKind,
  requestId: string,
): Promise<boolean> {
  const rows = await run(
    db,
    client,
    requestId,
    "check_credentials",
    "Consulta de credenciais concluída",
    "SELECT password_hash, salt FROM users WHERE username = $1",
    [username],
  );
  const user = rows[0] as { password_hash: string; salt: string } | undefined;
  return user !== undefined && verifyPassword(password, user.password_hash, user.salt);
}

// ===== #1 fim =====

// ===== #2 inicio: cadastro/edição web (B) =====
// ===== #2 fim =====

// ===== #3 inicio: listagem/exclusão web e seed (C) =====
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
