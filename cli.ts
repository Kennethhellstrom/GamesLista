import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Environment = Record<string, string | undefined>;
type Output = (message: string) => void;

const DEFAULT_API_URL = "http://api:8080";

function printHelp(output: Output): void {
  output(
    [
      "Usage: gameslista <command> [options]",
      "",
      "Commands:",
      "  help                          Show this help",
      "  health                        Check API availability",
      "  token [--token TOKEN]   Validate a token",
      "  add --title T --platform P --genre G --year Y --rating R [--notes N]",
      "                                Create a game (requires GAMESLIST_TOKEN)",
      "  edit <id> --title T --platform P --genre G --year Y --rating R [--notes N]",
      "                                Edit a game, replacing all fields (requires GAMESLIST_TOKEN)",
      "  list [--page N] [--page-size N] [--sort FIELD] [--order asc|desc]",
      "                                List games, paginated (requires GAMESLIST_TOKEN)",
      "  search [--q TEXT] [--platform TEXT] [--genre TEXT] [--year-min N] [--year-max N]",
      "         [--rating-min N] [--page N] [--page-size N] [--sort FIELD] [--order asc|desc]",
      "                                Search games with combined filters (requires GAMESLIST_TOKEN)",
      "  delete <id>                   Delete a game (requires GAMESLIST_TOKEN)",
      "  dashboard                     Show the indicators: games by genre, by platform and average rating by year",
      "                                (requires GAMESLIST_TOKEN)",
      "",
      "Environment:",
      "  GAMESLIST_API_URL             API URL (default: http://api:8080)",
      "  GAMESLIST_TOKEN               Bearer token for authenticated commands",
    ].join("\n"),
  );
}

function parseOptions(args: string[], allowedOptions: string[]): Map<string, string> {
  const options = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowedOptions.includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option ${option} requires a value.`);
    }

    options.set(option, value);
    index += 1;
  }

  return options;
}

function apiUrl(env: Environment): string {
  return (env.GAMESLIST_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

function reportHttpFailure(
  status: number,
  operation: "health" | "token",
  output: Output,
): void {
  if (status === 401 && operation === "token") {
    output("Error: Token not provided or invalid (401).");
    return;
  }

  output(`Error: ${operation} request failed with HTTP ${status}.`);
}

async function request(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  output: Output,
): Promise<Response | undefined> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error.";
    output(`Error: Could not reach the API: ${message}`);
    return undefined;
  }
}

export async function run(
  args: string[],
  fetchFn: typeof fetch,
  output: Output,
  env: Environment,
): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(output);
    return 0;
  }

  if (command === "health") {
    try {
      parseOptions(args.slice(1), []);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/health`,
      { method: "GET" },
      output,
    );
    if (!response) {
      return 1;
    }
    if (!response.ok) {
      reportHttpFailure(response.status, "health", output);
      return 1;
    }

    output(`API is healthy (HTTP ${response.status}).`);
    return 0;
  }

  if (command === "token") {
    let options: Map<string, string>;
    try {
      options = parseOptions(args.slice(1), ["--token"]);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = options.get("--token");

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { token } : {}),
      },
      output,
    );
    if (!response) {
      return 1;
    }
    if (!response.ok) {
      reportHttpFailure(response.status, "token", output);
      return 1;
    }

    output(`Token válido (HTTP ${response.status}).`);
    return 0;
  }

  // ===== #8 inicio =====
  if (command === "add" || command === "edit") {
    // Opção da CLI -> campo da API. A validação (mesmas regras e mensagens da Web) é feita pela API.
    const fields: Record<string, string> = {
      "--title": "title",
      "--platform": "platform",
      "--genre": "genre",
      "--year": "release_year",
      "--rating": "rating",
      "--notes": "notes",
    };
    const flagOf: Record<string, string> = Object.fromEntries(
      Object.entries(fields).map(([flag, field]) => [field, flag]),
    );
    const editing = command === "edit";
    const id = editing ? args[1] : undefined;
    if (editing && (!id || !/^[1-9]\d*$/.test(id))) {
      output("Error: Informe o id numérico do jogo: gameslista edit <id> --title ...");
      return 1;
    }

    let options: Map<string, string>;
    try {
      options = parseOptions(args.slice(editing ? 2 : 1), Object.keys(fields));
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = env.GAMESLIST_TOKEN;
    if (!token) {
      output("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
      return 1;
    }

    // Ano e nota vão como número quando forem numéricos (aceita vírgula: 8,5); senão vão como texto e a API recusa.
    const body: Record<string, unknown> = {};
    for (const [flag, value] of options) {
      const field = fields[flag];
      const number = Number(value.replace(",", "."));
      const numeric = (field === "release_year" || field === "rating") && value.trim() !== "" && Number.isFinite(number);
      body[field] = numeric ? number : value;
    }

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/records${editing ? `/${id}` : ""}`,
      {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
      output,
    );
    if (!response) {
      return 1;
    }
    if (response.status === 400) {
      const data = (await response.json().catch(() => ({}))) as { errors?: Record<string, string> };
      output("Error: Dados inválidos (400):");
      for (const [field, message] of Object.entries(data.errors ?? {})) {
        output(`  ${flagOf[field] ?? field}: ${message}`);
      }
      return 1;
    }
    if (response.status === 401) {
      output("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
      return 1;
    }
    if (response.status === 404 && editing) {
      output(`Error: Jogo ${id} não encontrado (404).`);
      return 1;
    }
    if (!response.ok) {
      output(`Error: ${command} request failed with HTTP ${response.status}.`);
      return 1;
    }

    const game = (await response.json()) as {
      id: number;
      title: string;
      platform: string;
      genre: string;
      release_year: number;
      rating: number;
      notes: string | null;
    };
    const notes = game.notes ? ` | ${game.notes}` : "";
    output(
      `${editing ? "Jogo atualizado" : "Jogo cadastrado"} (HTTP ${response.status}): ` +
        `#${game.id} ${game.title} | ${game.platform} | ${game.genre} | ${game.release_year} | nota ${game.rating}${notes}`,
    );
    return 0;
  }
  // ===== #8 fim =====
  // ===== #9 inicio =====
  if (command === "list" || command === "delete") {
    const listing = command === "list";
    const id = listing ? undefined : args[1];
    if (!listing && (!id || !/^[1-9]\d*$/.test(id))) {
      output("Error: Informe o id numérico do jogo: gameslista delete <id>");
      return 1;
    }

    let options: Map<string, string>;
    try {
      options = parseOptions(
        args.slice(listing ? 1 : 2),
        listing ? ["--page", "--page-size", "--sort", "--order"] : [],
      );
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = env.GAMESLIST_TOKEN;
    if (!token) {
      output("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
      return 1;
    }

    // --page-size vira page_size; a validação dos valores é feita pela API.
    const query = new URLSearchParams();
    for (const [flag, value] of options) {
      query.set(flag.slice(2).replace("-", "_"), value);
    }
    const queryString = query.toString();
    const path = listing ? `/api/cli/records${queryString ? `?${queryString}` : ""}` : `/api/cli/records/${id}`;

    const response = await request(
      fetchFn,
      `${apiUrl(env)}${path}`,
      { method: listing ? "GET" : "DELETE", headers: { Authorization: `Bearer ${token}` } },
      output,
    );
    if (!response) {
      return 1;
    }
    if (response.status === 401) {
      output("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
      return 1;
    }
    if (response.status === 400) {
      output(
        "Error: Parâmetros inválidos (400). Use --page e --page-size (1 a 100) com números inteiros, " +
          "--sort (id, title, platform, genre, rating, release_year) e --order (asc, desc).",
      );
      return 1;
    }
    if (response.status === 404) {
      output(`Error: Jogo ${id} não encontrado (404).`);
      return 1;
    }
    if (!response.ok) {
      output(`Error: ${command} request failed with HTTP ${response.status}.`);
      return 1;
    }

    if (!listing) {
      output(`Jogo ${id} excluído (HTTP ${response.status}).`);
      return 0;
    }

    const data = (await response.json()) as {
      items: { id: number; title: string; platform: string; genre: string; release_year: number; rating: number; notes: string | null }[];
      page: number;
      page_size: number;
      total: number;
    };
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    output(`Jogos (página ${data.page} de ${pages}, ${data.total} no total):`);
    if (data.items.length === 0) {
      output("Nenhum jogo nesta página.");
    }
    for (const game of data.items) {
      const notes = game.notes ? ` | ${game.notes}` : "";
      output(
        `#${game.id} ${game.title} | ${game.platform} | ${game.genre} | ${game.release_year} | nota ${game.rating}${notes}`,
      );
    }
    return 0;
  }
  // ===== #9 fim =====
  // ===== #10 inicio =====
  if (command === "search") {
    let options: Map<string, string>;
    try {
      options = parseOptions(args.slice(1), [
        "--q",
        "--platform",
        "--genre",
        "--year-min",
        "--year-max",
        "--rating-min",
        "--page",
        "--page-size",
        "--sort",
        "--order",
      ]);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = env.GAMESLIST_TOKEN;
    if (!token) {
      output("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
      return 1;
    }

    const query = new URLSearchParams();
    for (const [flag, value] of options) {
      query.set(flag.slice(2).replaceAll("-", "_"), value);
    }
    const queryString = query.toString();
    const path = `/api/cli/records/search${queryString ? `?${queryString}` : ""}`;
    const response = await request(
      fetchFn,
      `${apiUrl(env)}${path}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      output,
    );
    if (!response) {
      return 1;
    }
    if (response.status === 401) {
      output("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
      return 1;
    }
    if (response.status === 400) {
      output(
        "Error: Parâmetros inválidos (400). Use filtros de texto de até 100 caracteres, " +
          "--year-min/--year-max (inteiros positivos), --rating-min (0 a 10), --page e --page-size (1 a 100), " +
          "--sort (id, title, platform, genre, rating, release_year) e --order (asc, desc).",
      );
      return 1;
    }
    if (!response.ok) {
      output(`Error: search request failed with HTTP ${response.status}.`);
      return 1;
    }

    const data = (await response.json()) as {
      items: {
        id: number;
        title: string;
        platform: string;
        genre: string;
        release_year: number;
        rating: number;
        notes: string | null;
      }[];
      page: number;
      page_size: number;
      total: number;
    };
    output(`Jogos encontrados (${data.total} no total; página ${data.page}):`);
    output("ID | Título | Plataforma | Gênero | Ano | Nota | Observações");
    if (data.items.length === 0) {
      output("Nenhum jogo encontrado.");
    }
    for (const game of data.items) {
      output(
        `${game.id} | ${game.title} | ${game.platform} | ${game.genre} | ${game.release_year} | ${game.rating} | ${game.notes ?? ""}`,
      );
    }
    return 0;
  }
  // ===== #10 fim =====
  // ===== #11 inicio =====
  // ===== #11 fim =====
  // ===== #12 inicio =====
  if (command === "dashboard") {
    try {
      parseOptions(args.slice(1), []);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = env.GAMESLIST_TOKEN;
    if (!token) {
      output("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
      return 1;
    }

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/dashboard`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      output,
    );
    if (!response) {
      return 1;
    }
    if (response.status === 401) {
      output("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
      return 1;
    }
    if (!response.ok) {
      output(`Error: dashboard request failed with HTTP ${response.status}.`);
      return 1;
    }

    // Mesmo formato JSON do dashboard Web; aqui cada indicador sai como uma lista de texto.
    const data = (await response.json()) as Record<
      "by_genre" | "by_platform" | "avg_rating_by_year",
      { label: string; value: number }[]
    >;
    const sections: [string, { label: string; value: number }[]][] = [
      ["Jogos por gênero", data.by_genre],
      ["Jogos por plataforma", data.by_platform],
      ["Nota média por ano de lançamento", data.avg_rating_by_year],
    ];
    output("Indicadores");
    for (const [title, points] of sections) {
      output("");
      output(`${title}:`);
      if (points.length === 0) {
        output("  (sem dados)");
      }
      for (const point of points) {
        output(`  ${point.label}: ${point.value}`);
      }
    }
    return 0;
  }
  // ===== #12 fim =====

  output(`Error: Unknown command "${command}". Run "gameslista help" for usage.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run(process.argv.slice(2), fetch, (message) => console.log(message), process.env).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
  );
}
