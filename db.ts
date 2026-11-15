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

export interface GameRecordInput {
  title: string;
  platform: string;
  genre: string;
  release_year: number;
  rating: number;
  notes: string | null;
}

/** Persiste um jogo novo e devolve a linha criada. */
export async function webInsertRecord(
  db: Queryable,
  record: GameRecordInput,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord | null> {
  const rows = await run(
    db,
    client,
    requestId,
    "insert_record",
    "Jogo cadastrado",
    `INSERT INTO games (title, platform, genre, release_year, rating, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, platform, genre, release_year, rating, notes`,
    [record.title, record.platform, record.genre, record.release_year, record.rating, record.notes],
  );
  return (rows[0] as GameRecord | undefined) ?? null;
}

/** Atualiza somente jogos ativos; null indica que o id não existe ou está inativo. */
export async function webUpdateRecord(
  db: Queryable,
  id: number,
  record: GameRecordInput,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord | null> {
  const rows = await run(
    db,
    client,
    requestId,
    "update_record",
    "Jogo atualizado",
    `UPDATE games
        SET title = $2, platform = $3, genre = $4, release_year = $5, rating = $6, notes = $7
      WHERE id = $1 AND active = 1
      RETURNING id, title, platform, genre, release_year, rating, notes`,
    [id, record.title, record.platform, record.genre, record.release_year, record.rating, record.notes],
  );
  return (rows[0] as GameRecord | undefined) ?? null;
}

// ===== #2 fim =====

// ===== #3 inicio: listagem/exclusão web e seed (C) =====

export interface SeedGame {
  title: string;
  platform: string;
  genre: string;
  release_year: number;
  rating: number;
}

/** Jogos de exemplo (25+, 5+ gêneros, 4+ plataformas, 2000-2024) usados quando `GAMESLIST_SEED=true`. */
export const SEED_GAMES: readonly SeedGame[] = [
  { title: "The Legend of Zelda: Breath of the Wild", platform: "Switch", genre: "Aventura", release_year: 2017, rating: 9.8 },
  { title: "The Witcher 3: Wild Hunt", platform: "PC", genre: "RPG", release_year: 2015, rating: 9.7 },
  { title: "God of War", platform: "PlayStation", genre: "Ação", release_year: 2018, rating: 9.5 },
  { title: "Red Dead Redemption 2", platform: "PlayStation", genre: "Ação", release_year: 2018, rating: 9.6 },
  { title: "Super Mario Odyssey", platform: "Switch", genre: "Outro", release_year: 2017, rating: 9.4 },
  { title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3 },
  { title: "Celeste", platform: "PC", genre: "Outro", release_year: 2018, rating: 9.1 },
  { title: "Elden Ring", platform: "PC", genre: "RPG", release_year: 2022, rating: 9.5 },
  { title: "Halo 3", platform: "Xbox", genre: "Outro", release_year: 2007, rating: 8.9 },
  { title: "Forza Horizon 5", platform: "Xbox", genre: "Corrida", release_year: 2021, rating: 8.8 },
  { title: "Gran Turismo 3", platform: "PlayStation", genre: "Corrida", release_year: 2001, rating: 8.7 },
  { title: "Half-Life 2", platform: "PC", genre: "Outro", release_year: 2004, rating: 9.6 },
  { title: "Portal 2", platform: "PC", genre: "Puzzle", release_year: 2011, rating: 9.5 },
  { title: "Stardew Valley", platform: "PC", genre: "Outro", release_year: 2016, rating: 9.0 },
  { title: "Animal Crossing: New Horizons", platform: "Switch", genre: "Outro", release_year: 2020, rating: 8.6 },
  { title: "Metroid Dread", platform: "Switch", genre: "Aventura", release_year: 2021, rating: 8.8 },
  { title: "Final Fantasy X", platform: "PlayStation", genre: "RPG", release_year: 2001, rating: 9.0 },
  { title: "Grand Theft Auto: San Andreas", platform: "PlayStation", genre: "Ação", release_year: 2004, rating: 9.2 },
  { title: "Resident Evil 4", platform: "PlayStation", genre: "Outro", release_year: 2005, rating: 9.3 },
  { title: "Silent Hill 2", platform: "PlayStation", genre: "Outro", release_year: 2001, rating: 8.9 },
  { title: "Fable", platform: "Xbox", genre: "RPG", release_year: 2004, rating: 8.2 },
  { title: "Gears of War", platform: "Xbox", genre: "Outro", release_year: 2006, rating: 8.5 },
  { title: "Tetris Effect", platform: "PlayStation", genre: "Puzzle", release_year: 2018, rating: 8.4 },
  { title: "Hollow Knight", platform: "PC", genre: "Aventura", release_year: 2017, rating: 9.2 },
  { title: "Balatro", platform: "PC", genre: "Outro", release_year: 2024, rating: 8.9 },
  { title: "Astro Bot", platform: "PlayStation", genre: "Outro", release_year: 2024, rating: 9.4 },
  { title: "Fire Emblem: Three Houses", platform: "Switch", genre: "RPG", release_year: 2019, rating: 8.3 },
  { title: "Need for Speed: Underground", platform: "PC", genre: "Corrida", release_year: 2003, rating: 7.6 },
  { title: "E.T. the Extra-Terrestrial", platform: "Outro", genre: "Aventura", release_year: 2000, rating: 3.5 },
];

/**
 * Insere os jogos de exemplo só quando a tabela está vazia (idempotente). Conta TODAS as linhas,
 * inclusive as excluídas logicamente, para não recriar o seed depois de o usuário excluir jogos.
 * Devolve quantos jogos inseriu.
 */
export async function seedGames(db: Queryable, client: ClientKind, requestId: string): Promise<number> {
  const rows = await run(
    db,
    client,
    requestId,
    "seed_games_count",
    "Contagem de jogos para o seed concluída",
    "SELECT COUNT(*) AS total FROM games",
  );
  if (Number((rows[0] as { total: string | number }).total) > 0) return 0;

  const values: unknown[] = [];
  const tuples = SEED_GAMES.map((game, index) => {
    const base = index * 5;
    values.push(game.title, game.platform, game.genre, game.release_year, game.rating);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await run(
    db,
    client,
    requestId,
    "seed_games",
    `${SEED_GAMES.length} jogos de exemplo inseridos`,
    `INSERT INTO games (title, platform, genre, release_year, rating) VALUES ${tuples.join(", ")}`,
    values,
  );
  return SEED_GAMES.length;
}

/** Campos aceitos na ordenação: o texto do usuário só escolhe uma chave daqui, nunca vai ao SQL. */
const SORT_COLUMNS = {
  id: "id",
  title: "LOWER(title)",
  platform: "LOWER(platform)",
  genre: "LOWER(genre)",
  rating: "rating",
  release_year: "release_year",
} as const;

export type SortField = keyof typeof SORT_COLUMNS;
export type SortOrder = "asc" | "desc";

export function isSortField(value: unknown): value is SortField {
  return typeof value === "string" && Object.hasOwn(SORT_COLUMNS, value);
}

export interface GameRecord {
  id: number;
  title: string;
  platform: string;
  genre: string;
  release_year: number;
  rating: number;
  notes: string | null;
}

export interface ListOptions {
  page: number;
  pageSize: number;
  sort: SortField;
  order: SortOrder;
}

/** Lista uma página de jogos ativos, ordenada por um campo da lista permitida (desempate por id). */
export async function webListRecords(
  db: Queryable,
  options: ListOptions,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord[]> {
  const column = SORT_COLUMNS[options.sort];
  const direction = options.order === "desc" ? "DESC" : "ASC";
  const rows = await run(
    db,
    client,
    requestId,
    "list_records",
    "Listagem de jogos concluída",
    `SELECT id, title, platform, genre, release_year, rating, notes
       FROM games
      WHERE active = 1
      ORDER BY ${column} ${direction}, id ASC
      LIMIT $1 OFFSET $2`,
    [options.pageSize, (options.page - 1) * options.pageSize],
  );
  return rows as GameRecord[];
}

/** Total de jogos ativos (base da paginação). */
export async function webCountRecords(db: Queryable, client: ClientKind, requestId: string): Promise<number> {
  const rows = await run(
    db,
    client,
    requestId,
    "count_records",
    "Contagem de jogos concluída",
    "SELECT COUNT(*) AS total FROM games WHERE active = 1",
  );
  return Number((rows[0] as { total: string | number }).total);
}

/**
 * Exclusão lógica: marca o jogo como inativo (`active = 0`) em vez de apagar a linha.
 * Devolve `false` quando o id não existe ou já foi excluído.
 */
export async function webDeleteRecord(
  db: Queryable,
  id: number,
  client: ClientKind,
  requestId: string,
): Promise<boolean> {
  const rows = await run(
    db,
    client,
    requestId,
    "delete_record",
    "Exclusão lógica de jogo concluída",
    "UPDATE games SET active = 0 WHERE id = $1 AND active = 1 RETURNING id",
    [id],
  );
  return rows.length > 0;
}

// ===== #3 fim =====

// ===== #4 inicio: busca web (C) =====

/** Filtros combináveis da busca. Filtro ausente (ou texto vazio) é ignorado; os presentes se combinam com AND. */
export interface SearchFilters {
  /** Título contém o texto (sem diferenciar maiúsculas). */
  q?: string;
  /** Plataforma igual ao texto (sem diferenciar maiúsculas). */
  platform?: string;
  /** Gênero igual ao texto (sem diferenciar maiúsculas). */
  genre?: string;
  /** Ano de lançamento maior ou igual (inclusivo). */
  yearMin?: number;
  /** Ano de lançamento menor ou igual (inclusivo). */
  yearMax?: number;
  /** Nota maior ou igual (inclusivo). */
  ratingMin?: number;
}

export interface SearchOptions extends SearchFilters, ListOptions {}

/** Escapa `\`, `%` e `_` para o texto do usuário valer como texto literal dentro do LIKE. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Monta o WHERE da busca. Só trechos fixos entram no SQL: todo valor do usuário vai por parâmetro
 * ($1, $2, ...), nunca por concatenação. Jogos excluídos logicamente nunca aparecem.
 */
function buildSearchWhere(filters: SearchFilters): { where: string; values: unknown[] } {
  const conditions = ["active = 1"];
  const values: unknown[] = [];
  const add = (condition: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    conditions.push(condition(`$${values.length}`));
  };

  if (filters.q) add((p) => `LOWER(title) LIKE '%' || LOWER(${p}) || '%' ESCAPE '\\'`, escapeLike(filters.q));
  if (filters.platform) add((p) => `LOWER(platform) = LOWER(${p})`, filters.platform);
  if (filters.genre) add((p) => `LOWER(genre) = LOWER(${p})`, filters.genre);
  if (filters.yearMin !== undefined) add((p) => `release_year >= ${p}`, filters.yearMin);
  if (filters.yearMax !== undefined) add((p) => `release_year <= ${p}`, filters.yearMax);
  if (filters.ratingMin !== undefined) add((p) => `rating >= ${p}`, filters.ratingMin);

  return { where: conditions.join(" AND "), values };
}

/** Busca uma página de jogos ativos que atendem a todos os filtros, com a mesma ordenação da listagem. */
export async function webSearchRecords(
  db: Queryable,
  options: SearchOptions,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord[]> {
  const { where, values } = buildSearchWhere(options);
  const column = SORT_COLUMNS[options.sort];
  const direction = options.order === "desc" ? "DESC" : "ASC";
  const rows = await run(
    db,
    client,
    requestId,
    "search_records",
    "Busca de jogos concluída",
    `SELECT id, title, platform, genre, release_year, rating, notes
       FROM games
      WHERE ${where}
      ORDER BY ${column} ${direction}, id ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, options.pageSize, (options.page - 1) * options.pageSize],
  );
  return rows as GameRecord[];
}

/** Total de jogos que atendem aos filtros (base da paginação do resultado filtrado). */
export async function webCountSearchRecords(
  db: Queryable,
  filters: SearchFilters,
  client: ClientKind,
  requestId: string,
): Promise<number> {
  const { where, values } = buildSearchWhere(filters);
  const rows = await run(
    db,
    client,
    requestId,
    "count_search_records",
    "Contagem da busca concluída",
    `SELECT COUNT(*) AS total FROM games WHERE ${where}`,
    values,
  );
  return Number((rows[0] as { total: string | number }).total);
}

// ===== #4 fim =====

// ===== #5 inicio: exportação CSV web (A) =====
// ===== #5 fim =====

// ===== #6 inicio: dashboard web (A) =====

/** Um ponto de indicador: rótulo (gênero, plataforma ou ano) e valor (contagem ou nota média). */
export interface DashboardPoint {
  label: string;
  value: number;
}

/** Os 3 indicadores do dashboard, calculados só sobre jogos ativos (`active = 1`). */
export interface DashboardData {
  by_genre: DashboardPoint[];
  by_platform: DashboardPoint[];
  avg_rating_by_year: DashboardPoint[];
}

/** Converte as linhas `{label, value}` do banco (COUNT e AVG chegam como texto) em pontos numéricos. */
function toPoints(rows: unknown[]): DashboardPoint[] {
  return (rows as { label: string | number; value: string | number }[]).map((row) => ({
    label: String(row.label),
    value: Number(row.value),
  }));
}

/**
 * Calcula os 3 indicadores do dashboard com uma agregação (`GROUP BY`) cada:
 * jogos por gênero, jogos por plataforma e nota média por ano de lançamento (2 casas).
 * Gêneros e plataformas saem do maior para o menor valor; os anos, em ordem crescente.
 */
export async function webDashboard(db: Queryable, client: ClientKind, requestId: string): Promise<DashboardData> {
  const byGenre = await run(
    db,
    client,
    requestId,
    "dashboard_by_genre",
    "Indicador por gênero calculado",
    `SELECT genre AS label, COUNT(*) AS value
       FROM games
      WHERE active = 1
      GROUP BY genre
      ORDER BY value DESC, label ASC`,
  );
  const byPlatform = await run(
    db,
    client,
    requestId,
    "dashboard_by_platform",
    "Indicador por plataforma calculado",
    `SELECT platform AS label, COUNT(*) AS value
       FROM games
      WHERE active = 1
      GROUP BY platform
      ORDER BY value DESC, label ASC`,
  );
  const avgByYear = await run(
    db,
    client,
    requestId,
    "dashboard_avg_rating_by_year",
    "Indicador de nota média por ano calculado",
    `SELECT release_year AS label, ROUND(AVG(rating)::numeric, 2) AS value
       FROM games
      WHERE active = 1
      GROUP BY release_year
      ORDER BY release_year ASC`,
  );
  return {
    by_genre: toPoints(byGenre),
    by_platform: toPoints(byPlatform),
    avg_rating_by_year: toPoints(avgByYear),
  };
}

// ===== #6 fim =====

// ===== #7 inicio: estrutura CLI (B) =====
// ===== #7 fim =====

// ===== #8 inicio: cadastro/edição CLI (A) =====

/** Cadastra um jogo vindo da CLI (SQL próprio, sem chamar os métodos `web...`) e devolve a linha criada. */
export async function cliInsertRecord(
  db: Queryable,
  record: GameRecordInput,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord> {
  const rows = await run(
    db,
    client,
    requestId,
    "cli_insert_record",
    "Jogo cadastrado pela CLI",
    `INSERT INTO games (title, platform, genre, release_year, rating, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, platform, genre, release_year, rating, notes`,
    [record.title, record.platform, record.genre, record.release_year, record.rating, record.notes],
  );
  return rows[0] as GameRecord;
}

/**
 * Edita um jogo ativo vindo da CLI, substituindo todos os campos (SQL próprio).
 * Devolve `null` quando o id não existe ou o jogo foi excluído logicamente.
 */
export async function cliUpdateRecord(
  db: Queryable,
  id: number,
  record: GameRecordInput,
  client: ClientKind,
  requestId: string,
): Promise<GameRecord | null> {
  const rows = await run(
    db,
    client,
    requestId,
    "cli_update_record",
    "Edição de jogo pela CLI concluída",
    `UPDATE games
        SET title = $2, platform = $3, genre = $4, release_year = $5, rating = $6, notes = $7
      WHERE id = $1 AND active = 1
      RETURNING id, title, platform, genre, release_year, rating, notes`,
    [id, record.title, record.platform, record.genre, record.release_year, record.rating, record.notes],
  );
  return (rows[0] as GameRecord | undefined) ?? null;
}

// ===== #8 fim =====

// ===== #9 inicio: listagem/exclusão CLI (C) =====
// ===== #9 fim =====

// ===== #10 inicio: busca CLI (B) =====
// ===== #10 fim =====

// ===== #11 inicio: exportação CSV CLI (C) =====
// ===== #11 fim =====

// ===== #12 inicio: indicadores CLI (B) =====
// ===== #12 fim =====
