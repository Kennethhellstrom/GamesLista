import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

// Testes da issue #9 (subcomandos list e delete da CLI, com fetch falso).

function response(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
}

const ENV = { GAMESLIST_API_URL: "http://api:8080/", GAMESLIST_TOKEN: "cli-token" };
const GAME = { id: 3, title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3, notes: null };

function page(items: unknown[], total: number, pageNumber = 1, pageSize = 5) {
  return { items, page: pageNumber, page_size: pageSize, total };
}

describe("CLI list", () => {
  it("lista a primeira página sem parâmetros, enviando o Bearer", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, page([GAME, { ...GAME, id: 4, title: "Celeste", notes: "Difícil" }], 12)));
    const output = vi.fn();

    await expect(run(["list"], fetchFn, output, ENV)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/records", {
      method: "GET",
      headers: { Authorization: "Bearer cli-token" },
    });
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Jogos (página 1 de 3, 12 no total):",
      "#3 Hades | PC | Outro | 2020 | nota 9.3",
      "#4 Celeste | PC | Outro | 2020 | nota 9.3 | Difícil",
    ]);
  });

  it("converte as opções em parâmetros da API (--page-size vira page_size)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, page([GAME], 1, 2, 3)));

    await run(["list", "--page", "2", "--page-size", "3", "--sort", "title", "--order", "desc"], fetchFn, vi.fn(), ENV);
    expect(fetchFn.mock.calls[0][0]).toBe("http://api:8080/api/cli/records?page=2&page_size=3&sort=title&order=desc");
  });

  it("avisa quando a página está vazia e mostra pelo menos 1 página", async () => {
    const output = vi.fn();

    await expect(run(["list"], vi.fn().mockResolvedValue(response(200, page([], 0))), output, ENV)).resolves.toBe(0);
    expect(output.mock.calls.map((call) => call[0])).toEqual(["Jogos (página 1 de 1, 0 no total):", "Nenhum jogo nesta página."]);
  });

  it("mostra a mensagem de parâmetros inválidos no 400", async () => {
    const output = vi.fn();

    await expect(run(["list", "--page", "0"], vi.fn().mockResolvedValue(response(400, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Parâmetros inválidos (400)"));
  });

  it("recusa opção desconhecida e opção sem valor", async () => {
    const output = vi.fn();
    const fetchFn = vi.fn();

    await expect(run(["list", "--foo", "1"], fetchFn, output, ENV)).resolves.toBe(1);
    await expect(run(["list", "--page"], fetchFn, output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --foo");
    expect(output).toHaveBeenCalledWith("Error: Option --page requires a value.");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("CLI delete", () => {
  it("exclui o jogo e mostra a confirmação", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(204));
    const output = vi.fn();

    await expect(run(["delete", "3"], fetchFn, output, ENV)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/records/3", {
      method: "DELETE",
      headers: { Authorization: "Bearer cli-token" },
    });
    expect(output).toHaveBeenCalledWith("Jogo 3 excluído (HTTP 204).");
  });

  it.each([[["delete"]], [["delete", "abc"]], [["delete", "0"]], [["delete", "-2"]]])(
    "exige um id numérico (%j)",
    async (args) => {
      const output = vi.fn();
      const fetchFn = vi.fn();

      await expect(run(args, fetchFn, output, ENV)).resolves.toBe(1);
      expect(output).toHaveBeenCalledWith("Error: Informe o id numérico do jogo: gameslista delete <id>");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("recusa opções extras", async () => {
    const output = vi.fn();

    await expect(run(["delete", "3", "--force", "1"], vi.fn(), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --force");
  });

  it("informa 404 quando o jogo não existe", async () => {
    const output = vi.fn();

    await expect(run(["delete", "99"], vi.fn().mockResolvedValue(response(404, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Jogo 99 não encontrado (404).");
  });
});

describe("CLI list e delete: falhas comuns", () => {
  it.each([[["list"]], [["delete", "3"]]])("exige GAMESLIST_TOKEN (%j)", async (args) => {
    const output = vi.fn();
    const fetchFn = vi.fn();

    await expect(run(args, fetchFn, output, { GAMESLIST_API_URL: "http://api:8080" })).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([[["list"]], [["delete", "3"]]])("informa 401 com token inválido (%j)", async (args) => {
    const output = vi.fn();

    await expect(run(args, vi.fn().mockResolvedValue(response(401, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
  });

  it.each([
    [["list"], "list"],
    [["delete", "3"], "delete"],
  ])("informa outras falhas HTTP (%j)", async (args, command) => {
    const output = vi.fn();

    await expect(run(args, vi.fn().mockResolvedValue(response(500, { error: "x" })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith(`Error: ${command} request failed with HTTP 500.`);
  });

  it.each([[["list"]], [["delete", "3"]]])("informa falha de rede (%j)", async (args) => {
    const output = vi.fn();

    await expect(run(args, vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: ECONNREFUSED");
  });
});
