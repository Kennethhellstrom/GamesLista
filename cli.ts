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
      "  token --user U --password P   Obtain an API token",
      "",
      "Options:",
      "  --token TOKEN                 Authenticate a command",
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
    output("Error: Invalid username or password (401).");
    return;
  }
  if (status === 401) {
    output("Error: Unauthorized (401). Supply a valid token with --token or GAMESLIST_TOKEN.");
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
    let options: Map<string, string>;
    try {
      options = parseOptions(args.slice(1), ["--token"]);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const token = options.get("--token") || env.GAMESLIST_TOKEN;
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/health`,
      { method: "GET", headers },
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
      options = parseOptions(args.slice(1), ["--user", "--password"]);
    } catch (error) {
      output(`Error: ${error instanceof Error ? error.message : "Invalid command options."}`);
      return 1;
    }

    const user = options.get("--user");
    const password = options.get("--password");
    if (!user || !password) {
      output("Error: token requires both --user and --password.");
      return 1;
    }

    const response = await request(
      fetchFn,
      `${apiUrl(env)}/api/cli/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
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

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      output("Error: API returned an invalid token response.");
      return 1;
    }
    if (
      typeof result !== "object" ||
      result === null ||
      !("token" in result) ||
      typeof result.token !== "string" ||
      !result.token
    ) {
      output("Error: API returned an invalid token response.");
      return 1;
    }

    output(result.token);
    return 0;
  }

  // ===== #8 inicio =====
  // ===== #8 fim =====
  // ===== #9 inicio =====
  // ===== #9 fim =====
  // ===== #10 inicio =====
  // ===== #10 fim =====
  // ===== #11 inicio =====
  // ===== #11 fim =====
  // ===== #12 inicio =====
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
