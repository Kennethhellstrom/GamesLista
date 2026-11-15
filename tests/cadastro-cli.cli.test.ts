import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

// Testes da issue #8 (subcomandos add e edit da CLI, com fetch falso).

function response(status: number, body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const ENV = { GAMESLIST_API_URL: "http://api:8080/", GAMESLIST_TOKEN: "cli-token" };
const FIELDS = ["--title", "Hades", "--platform", "PC", "--genre", "Outro", "--year", "2020", "--rating", "9.3"];
const GAME = { id: 30, title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3, notes: null };

function lastBody(fetchFn: ReturnType<typeof vi.fn>): unknown {
  return JSON.parse(String((fetchFn.mock.calls.at(-1)![1] as RequestInit).body));
}

describe("CLI add", () => {
  it("cria um jogo válido enviando os campos, o Bearer e números para ano e nota", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, GAME));
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], fetchFn, output, ENV)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer cli-token" },
      body: JSON.stringify({ title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3 }),
    });
    expect(output).toHaveBeenCalledWith("Jogo cadastrado (HTTP 200): #30 Hades | PC | Outro | 2020 | nota 9.3");
  });

  it("envia observações e aceita nota com vírgula", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, { ...GAME, rating: 8.5, notes: "Ótimo" }));
    const output = vi.fn();
    const args = ["add", ...FIELDS.slice(0, 8), "--rating", "8,5", "--notes", "Ótimo"];

    await expect(run(args, fetchFn, output, ENV)).resolves.toBe(0);
    expect(lastBody(fetchFn)).toMatchObject({ rating: 8.5, notes: "Ótimo" });
    expect(output).toHaveBeenCalledWith("Jogo cadastrado (HTTP 200): #30 Hades | PC | Outro | 2020 | nota 8.5 | Ótimo");
  });

  it("manda ano e nota não numéricos como texto, para a API recusar com a mensagem dela", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(400, { errors: {} }));
    const args = ["add", ...FIELDS.slice(0, 6), "--year", "dois mil", "--rating", " "];

    await run(args, fetchFn, vi.fn(), ENV);
    expect(lastBody(fetchFn)).toMatchObject({ release_year: "dois mil", rating: " " });
  });

  it("mostra os erros de validação por campo, com o nome da opção da CLI", async () => {
    const errors = {
      title: "Informe um título de 1 a 100 caracteres.",
      release_year: "Informe um ano inteiro entre 1970 e 2027.",
      rating: "Informe uma nota de 0 a 10.",
      extra: "Campo desconhecido.",
    };
    const output = vi.fn();

    await expect(run(["add", "--rating", "11"], vi.fn().mockResolvedValue(response(400, { errors })), output, ENV)).resolves.toBe(1);
    expect(output.mock.calls.map((call) => call[0])).toEqual([
      "Error: Dados inválidos (400):",
      "  --title: Informe um título de 1 a 100 caracteres.",
      "  --year: Informe um ano inteiro entre 1970 e 2027.",
      "  --rating: Informe uma nota de 0 a 10.",
      "  extra: Campo desconhecido.",
    ]);
  });

  it("trata resposta 400 sem corpo JSON", async () => {
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], vi.fn().mockResolvedValue(response(400, "x")), output, ENV)).resolves.toBe(1);
    expect(output.mock.calls).toEqual([["Error: Dados inválidos (400):"]]);
  });

  it("reporta 401 (token inválido)", async () => {
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], vi.fn().mockResolvedValue(response(401)), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
  });

  it("exige GAMESLIST_TOKEN antes de chamar a API", async () => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], fetchFn, output, { GAMESLIST_TOKEN: "" })).resolves.toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
  });

  it.each([
    [["add", "--bad", "x"], "Error: Unknown option: --bad"],
    [["add", "--title"], "Error: Option --title requires a value."],
    [["add", "--title", "--platform", "PC"], "Error: Option --title requires a value."],
  ])("rejeita opções inválidas %j sem chamar a API", async (args, message) => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(args, fetchFn, output, ENV)).resolves.toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(message);
  });

  it.each([404, 500])("reporta outros erros HTTP (%i)", async (status) => {
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], vi.fn().mockResolvedValue(response(status)), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith(`Error: add request failed with HTTP ${status}.`);
  });

  it("reporta falha de conexão com a API", async () => {
    const output = vi.fn();

    await expect(run(["add", ...FIELDS], vi.fn().mockRejectedValue(new Error("offline")), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: offline");
  });
});

describe("CLI edit", () => {
  it("edita um jogo existente com PUT no id informado", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, { ...GAME, id: 5 }));
    const output = vi.fn();

    await expect(run(["edit", "5", ...FIELDS], fetchFn, output, ENV)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/records/5", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer cli-token" },
      body: JSON.stringify({ title: "Hades", platform: "PC", genre: "Outro", release_year: 2020, rating: 9.3 }),
    });
    expect(output).toHaveBeenCalledWith("Jogo atualizado (HTTP 200): #5 Hades | PC | Outro | 2020 | nota 9.3");
  });

  it("reporta id inexistente (404)", async () => {
    const output = vi.fn();

    await expect(run(["edit", "999", ...FIELDS], vi.fn().mockResolvedValue(response(404)), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Jogo 999 não encontrado (404).");
  });

  it("mostra os erros de validação da edição", async () => {
    const output = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(response(400, { errors: { genre: "Selecione um gênero válido." } }));

    await expect(run(["edit", "5", ...FIELDS], fetchFn, output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("  --genre: Selecione um gênero válido.");
  });

  it("reporta 401 na edição", async () => {
    const output = vi.fn();

    await expect(run(["edit", "5", ...FIELDS], vi.fn().mockResolvedValue(response(401)), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
  });

  it.each([[["edit"]], [["edit", "--title", "x"]], [["edit", "abc"]], [["edit", "0"]], [["edit", "../token"]]])(
    "exige um id numérico válido: %j",
    async (args) => {
      const fetchFn = vi.fn();
      const output = vi.fn();

      await expect(run(args, fetchFn, output, ENV)).resolves.toBe(1);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith("Error: Informe o id numérico do jogo: gameslista edit <id> --title ...");
    },
  );

  it("rejeita opção desconhecida depois do id", async () => {
    const output = vi.fn();

    await expect(run(["edit", "5", "--id", "6"], vi.fn(), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --id");
  });
});

describe("CLI help", () => {
  it("documenta add e edit", async () => {
    const output = vi.fn();

    await run(["help"], vi.fn(), output, {});
    expect(output.mock.calls[0][0]).toContain("add --title T --platform P --genre G --year Y --rating R [--notes N]");
    expect(output.mock.calls[0][0]).toContain("edit <id> --title T");
  });
});
