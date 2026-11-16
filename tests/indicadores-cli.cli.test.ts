import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

// Testes da issue #12 (subcomando dashboard da CLI, com fetch falso).

function response(status: number, body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const ENV = { GAMESLIST_API_URL: "http://api:8080/", GAMESLIST_TOKEN: "cli-token" };

const DASHBOARD = {
  by_genre: [{ label: "RPG", value: 2 }, { label: "Ação", value: 1 }],
  by_platform: [{ label: "PC", value: 3 }],
  avg_rating_by_year: [{ label: "2018", value: 9.15 }, { label: "2020", value: 8 }],
};

describe("CLI dashboard", () => {
  it("mostra em texto os 3 indicadores, enviando o Bearer", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, DASHBOARD));
    const output = vi.fn();

    await expect(run(["dashboard"], fetchFn, output, ENV)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/dashboard", {
      method: "GET",
      headers: { Authorization: "Bearer cli-token" },
    });
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Indicadores",
      "",
      "Jogos por gênero:",
      "  RPG: 2",
      "  Ação: 1",
      "",
      "Jogos por plataforma:",
      "  PC: 3",
      "",
      "Nota média por ano de lançamento:",
      "  2018: 9.15",
      "  2020: 8",
    ]);
  });

  it("mostra '(sem dados)' em cada indicador quando a tabela está vazia", async () => {
    const empty = { by_genre: [], by_platform: [], avg_rating_by_year: [] };
    const output = vi.fn();

    await expect(run(["dashboard"], vi.fn().mockResolvedValue(response(200, empty)), output, ENV)).resolves.toBe(0);
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Indicadores",
      "",
      "Jogos por gênero:",
      "  (sem dados)",
      "",
      "Jogos por plataforma:",
      "  (sem dados)",
      "",
      "Nota média por ano de lançamento:",
      "  (sem dados)",
    ]);
  });

  it("informa 401 com token inválido", async () => {
    const output = vi.fn();

    await expect(run(["dashboard"], vi.fn().mockResolvedValue(response(401, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
  });

  it("exige GAMESLIST_TOKEN e não chama a API sem ele", async () => {
    const output = vi.fn();
    const fetchFn = vi.fn();

    await expect(run(["dashboard"], fetchFn, output, { GAMESLIST_API_URL: "http://api:8080" })).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("recusa opções, porque o comando não aceita nenhuma", async () => {
    const output = vi.fn();
    const fetchFn = vi.fn();

    await expect(run(["dashboard", "--foo", "1"], fetchFn, output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --foo");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("informa outras falhas HTTP", async () => {
    const output = vi.fn();

    await expect(run(["dashboard"], vi.fn().mockResolvedValue(response(500, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: dashboard request failed with HTTP 500.");
  });

  it("informa falha de rede", async () => {
    const output = vi.fn();

    await expect(run(["dashboard"], vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: ECONNREFUSED");
  });
});
