import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

function response(status: number, body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const ENV = { GAMESLIST_API_URL: "http://api:8080/", GAMESLIST_TOKEN: "cli-token" };
const GAME = {
  id: 3,
  title: "Hades",
  platform: "PC",
  genre: "Roguelike",
  release_year: 2020,
  rating: 9.3,
  notes: "Ótimo",
};

function page(items: unknown[], total: number) {
  return { items, page: 2, page_size: 3, total };
}

describe("CLI search", () => {
  it("envia filtros combinados para a rota de busca e exibe uma tabela com total", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, page([GAME], 7)));
    const output = vi.fn();

    await expect(
      run(
        [
          "search",
          "--q",
          "ha",
          "--platform",
          "PC",
          "--genre",
          "Roguelike",
          "--year-min",
          "2015",
          "--rating-min",
          "8",
          "--page",
          "2",
          "--page-size",
          "3",
          "--sort",
          "rating",
          "--order",
          "desc",
        ],
        fetchFn,
        output,
        ENV,
      ),
    ).resolves.toBe(0);

    expect(fetchFn).toHaveBeenCalledWith(
      "http://api:8080/api/cli/records/search?q=ha&platform=PC&genre=Roguelike&year_min=2015&rating_min=8&page=2&page_size=3&sort=rating&order=desc",
      { method: "GET", headers: { Authorization: "Bearer cli-token" } },
    );
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Jogos encontrados (7 no total; página 2):",
      "ID | Título | Plataforma | Gênero | Ano | Nota | Observações",
      "3 | Hades | PC | Roguelike | 2020 | 9.3 | Ótimo",
    ]);
  });

  it("exibe mensagem quando nenhum jogo corresponde", async () => {
    const output = vi.fn();

    await expect(run(["search"], vi.fn().mockResolvedValue(response(200, page([], 0))), output, ENV)).resolves.toBe(
      0,
    );
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Jogos encontrados (0 no total; página 2):",
      "ID | Título | Plataforma | Gênero | Ano | Nota | Observações",
      "Nenhum jogo encontrado.",
    ]);
  });

  it("exige token e não acessa a API sem ele", async () => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(["search", "--platform", "PC"], fetchFn, output, { GAMESLIST_TOKEN: "" })).resolves.toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
  });

  it("rejeita opções desconhecidas e sem valor antes da chamada HTTP", async () => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(["search", "--unknown", "x"], fetchFn, output, ENV)).resolves.toBe(1);
    await expect(run(["search", "--page"], fetchFn, output, ENV)).resolves.toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Error: Unknown option: --unknown",
      "Error: Option --page requires a value.",
    ]);
  });

  it("trata 400, 401, outros erros HTTP e falhas de rede", async () => {
    const output = vi.fn();

    await expect(run(["search"], vi.fn().mockResolvedValue(response(400)), output, ENV)).resolves.toBe(1);
    await expect(run(["search"], vi.fn().mockResolvedValue(response(401)), output, ENV)).resolves.toBe(1);
    await expect(run(["search"], vi.fn().mockResolvedValue(response(500)), output, ENV)).resolves.toBe(1);
    await expect(run(["search"], vi.fn().mockRejectedValue(new Error("offline")), output, ENV)).resolves.toBe(1);

    expect(output.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining("Parâmetros inválidos (400)"),
      "Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.",
      "Error: search request failed with HTTP 500.",
      "Error: Could not reach the API: offline",
    ]);
  });
});
