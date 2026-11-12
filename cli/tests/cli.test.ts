import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("CLI", () => {
  it.each([{ args: [] }, { args: ["help"] }, { args: ["--help"] }])(
    "prints help for args $args",
    async ({ args }) => {
      const output = vi.fn();

      await expect(run(args, vi.fn(), output, {})).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: gameslista"));
    },
  );

  it("runs the CLI entry point when invoked directly", async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [process.argv[0], resolve("cli.ts"), "help"];

    try {
      vi.resetModules();
      await import("../cli.js");
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      log.mockRestore();
    }
  });

  it("calls the health endpoint and sends a token from the environment", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200));
    const output = vi.fn();

    await expect(
      run(["health"], fetchFn, output, {
        GAMESLIST_API_URL: "https://example.test/",
        GAMESLIST_TOKEN: "env-token",
      }),
    ).resolves.toBe(0);

    expect(fetchFn).toHaveBeenCalledWith("https://example.test/api/cli/health", {
      method: "GET",
      headers: { Authorization: "Bearer env-token" },
    });
    expect(output).toHaveBeenCalledWith("API is healthy (HTTP 200).");
  });

  it("prefers an explicit health token over the environment token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200));

    await run(["health", "--token", "cli-token"], fetchFn, vi.fn(), {
      GAMESLIST_TOKEN: "env-token",
    });

    expect(fetchFn.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer cli-token",
    });
  });

  it("reports unauthorized health requests with a non-zero code", async () => {
    const output = vi.fn();

    await expect(run(["health"], vi.fn().mockResolvedValue(response(401)), output, {})).resolves.toBe(
      1,
    );
    expect(output).toHaveBeenCalledWith(
      "Error: Unauthorized (401). Supply a valid token with --token or GAMESLIST_TOKEN.",
    );
  });

  it("reports other health errors", async () => {
    const output = vi.fn();

    await expect(run(["health"], vi.fn().mockResolvedValue(response(503)), output, {})).resolves.toBe(
      1,
    );
    expect(output).toHaveBeenCalledWith("Error: health request failed with HTTP 503.");
  });

  it("rejects invalid health options", async () => {
    const output = vi.fn();

    await expect(run(["health", "--bad"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --bad");
  });

  it("rejects a health token option without a value", async () => {
    const output = vi.fn();

    await expect(run(["health", "--token"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Option --token requires a value.");
  });

  it("obtains and prints a token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, { token: "issued-token" }));
    const output = vi.fn();

    await expect(
      run(["token", "--user", "alice", "--password", "secret"], fetchFn, output, {
        GAMESLIST_API_URL: "http://api:8080/",
      }),
    ).resolves.toBe(0);

    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "alice", password: "secret" }),
    });
    expect(output).toHaveBeenCalledWith("issued-token");
  });

  it("reports invalid credentials", async () => {
    const output = vi.fn();

    await expect(
      run(
        ["token", "--user", "alice", "--password", "wrong"],
        vi.fn().mockResolvedValue(response(401)),
        output,
        {},
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Invalid username or password (401).");
  });

  it("reports other token endpoint errors", async () => {
    const output = vi.fn();

    await expect(
      run(
        ["token", "--user", "alice", "--password", "secret"],
        vi.fn().mockResolvedValue(response(500)),
        output,
        {},
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: token request failed with HTTP 500.");
  });

  it("requires both token credentials", async () => {
    const output = vi.fn();

    await expect(run(["token", "--user", "alice"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: token requires both --user and --password.");
  });

  it("rejects invalid token options", async () => {
    const output = vi.fn();

    await expect(
      run(["token", "--user", "alice", "--password"], vi.fn(), output, {}),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Option --password requires a value.");
  });

  it("rejects token responses without a token", async () => {
    const output = vi.fn();

    await expect(
      run(
        ["token", "--user", "alice", "--password", "secret"],
        vi.fn().mockResolvedValue(response(200, {})),
        output,
        {},
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: API returned an invalid token response.");
  });

  it("rejects malformed token JSON", async () => {
    const output = vi.fn();
    const invalidJson = new Response("not-json", { status: 200 });

    await expect(
      run(
        ["token", "--user", "alice", "--password", "secret"],
        vi.fn().mockResolvedValue(invalidJson),
        output,
        {},
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: API returned an invalid token response.");
  });

  it("reports API connection errors", async () => {
    const output = vi.fn();

    await expect(
      run(["health"], vi.fn().mockRejectedValue(new Error("offline")), output, {}),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: offline");
  });

  it("reports connection errors while obtaining a token", async () => {
    const output = vi.fn();

    await expect(
      run(
        ["token", "--user", "alice", "--password", "secret"],
        vi.fn().mockRejectedValue(new Error("offline")),
        output,
        {},
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: offline");
  });

  it("reports non-Error connection failures", async () => {
    const output = vi.fn();

    await expect(
      run(["health"], vi.fn().mockRejectedValue("offline"), output, {}),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: Unknown network error.");
  });

  it("reports unknown commands", async () => {
    const output = vi.fn();

    await expect(run(["wat"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith(
      'Error: Unknown command "wat". Run "gameslista help" for usage.',
    );
  });
});
