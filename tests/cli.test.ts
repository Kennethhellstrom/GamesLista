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

  it("calls the public health endpoint without sending an environment token", async () => {
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
    });
    expect(output).toHaveBeenCalledWith("API is healthy (HTTP 200).");
  });

  it("rejects health options", async () => {
    const output = vi.fn();

    await expect(run(["health", "--token", "cli-token"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --token");
  });

  it("reports unauthorized health responses without suggesting a token", async () => {
    const output = vi.fn();

    await expect(run(["health"], vi.fn().mockResolvedValue(response(401)), output, {})).resolves.toBe(
      1,
    );
    expect(output).toHaveBeenCalledWith("Error: health request failed with HTTP 401.");
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

  it("rejects a token option for health", async () => {
    const output = vi.fn();

    await expect(run(["health", "--token"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --token");
  });

  it("validates a provided token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, { message: "Token válido" }));
    const output = vi.fn();

    await expect(
      run(["token", "--token", "issued-token"], fetchFn, output, {
        GAMESLIST_API_URL: "http://api:8080/",
      }),
    ).resolves.toBe(0);

    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "issued-token" }),
    });
    expect(output).toHaveBeenCalledWith("Token válido (HTTP 200).");
  });

  it("submits a missing token and reports unauthorized", async () => {
    const output = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(response(401));

    await expect(
      run(["token"], fetchFn, output, {}),
    ).resolves.toBe(1);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(output).toHaveBeenCalledWith("Error: Token not provided or invalid (401).");
  });

  it("reports other token endpoint errors", async () => {
    const output = vi.fn();

    await expect(
      run(["token", "--token", "issued-token"], vi.fn().mockResolvedValue(response(500)), output, {}),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: token request failed with HTTP 500.");
  });

  it("rejects unknown token options", async () => {
    const output = vi.fn();

    await expect(
      run(["token", "--bad"], vi.fn(), output, {}),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --bad");
  });

  it("rejects a token option without a value", async () => {
    const output = vi.fn();

    await expect(run(["token", "--token"], vi.fn(), output, {})).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Option --token requires a value.");
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
        ["token", "--token", "issued-token"],
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
