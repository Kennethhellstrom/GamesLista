import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run, saveFile } from "../cli.js";

// Testes da issue #11 (comando export da CLI, com fetch falso e gravação de arquivo falsa).

const CSV = '"id","title","platform","genre","release_year","rating","notes","active"\r\n"1","Hades","PC","Outro","2020","9.3","","1"';
const ENV = { GAMESLIST_API_URL: "http://api:8080/", GAMESLIST_TOKEN: "cli-token" };

function csvResponse(status = 200, body = CSV): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/csv; charset=utf-8" } });
}

function urlOf(fetchFn: ReturnType<typeof vi.fn>): string {
  return String(fetchFn.mock.calls[0][0]);
}

describe("CLI export", () => {
  it("sem --output imprime o CSV na tela e não grava arquivo", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse());
    const output = vi.fn();
    const save = vi.fn();

    await expect(run(["export"], fetchFn, output, ENV, save)).resolves.toBe(0);
    expect(fetchFn).toHaveBeenCalledWith("http://api:8080/api/cli/records/export", {
      method: "GET",
      headers: { Authorization: "Bearer cli-token" },
    });
    expect(output).toHaveBeenCalledWith(CSV);
    expect(save).not.toHaveBeenCalled();
  });

  it("envia os filtros como parâmetros da API (year-min vira year_min) e não envia --output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse());
    const args = [
      "export",
      "--q",
      "zelda",
      "--platform",
      "PC",
      "--genre",
      "RPG",
      "--year-min",
      "2015",
      "--year-max",
      "2022",
      "--rating-min",
      "8.5",
      "--output",
      "jogos.csv",
    ];

    await run(args, fetchFn, vi.fn(), ENV, vi.fn());
    expect(urlOf(fetchFn)).toBe(
      "http://api:8080/api/cli/records/export?q=zelda&platform=PC&genre=RPG&year_min=2015&year_max=2022&rating_min=8.5",
    );
  });

  it("codifica filtros com acento e espaço na consulta", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse());
    await run(["export", "--genre", "Ação e Aventura"], fetchFn, vi.fn(), ENV, vi.fn());
    expect(new URL(urlOf(fetchFn)).searchParams.get("genre")).toBe("Ação e Aventura");
  });

  it("grava o arquivo em GAMESLIST_EXPORT_DIR quando --output é relativo", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse());
    const output = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const env = { ...ENV, GAMESLIST_EXPORT_DIR: "/exports" };

    await expect(run(["export", "--output", "jogos.csv"], fetchFn, output, env, save)).resolves.toBe(0);
    expect(save).toHaveBeenCalledWith(resolve("/exports", "jogos.csv"), CSV);
    expect(output).toHaveBeenCalledWith(`CSV gravado em ${resolve("/exports", "jogos.csv")} (HTTP 200).`);
    expect(output).not.toHaveBeenCalledWith(CSV);
  });

  it("respeita um --output absoluto, mesmo com GAMESLIST_EXPORT_DIR", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const env = { ...ENV, GAMESLIST_EXPORT_DIR: "/exports" };
    const target = resolve("/tmp/fora/jogos.csv");

    await run(["export", "--output", target], vi.fn().mockResolvedValue(csvResponse()), vi.fn(), env, save);
    expect(save).toHaveBeenCalledWith(target, CSV);
  });

  it("sem GAMESLIST_EXPORT_DIR, um --output relativo vai para a pasta atual", async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    await run(["export", "--output", "jogos.csv"], vi.fn().mockResolvedValue(csvResponse()), vi.fn(), ENV, save);
    expect(save).toHaveBeenCalledWith(resolve(".", "jogos.csv"), CSV);
  });

  it("exporta o resultado inteiro, não só uma página, e grava exatamente o que a API devolveu", async () => {
    const many = ["header", ...Array.from({ length: 12 }, (_, index) => `linha ${index + 1}`)].join("\r\n");
    const save = vi.fn().mockResolvedValue(undefined);

    await run(["export", "--output", "todos.csv"], vi.fn().mockResolvedValue(csvResponse(200, many)), vi.fn(), ENV, save);
    expect(save.mock.calls[0][1]).toBe(many);
  });

  it("avisa e retorna 1 quando não consegue gravar o arquivo (erro e valor não Error)", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => csvResponse());

    const output = vi.fn();
    await expect(
      run(["export", "--output", "a.csv"], fetchFn, output, ENV, vi.fn().mockRejectedValue(new Error("sem permissão"))),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Não foi possível gravar o arquivo: sem permissão");

    const other = vi.fn();
    await expect(run(["export", "--output", "a.csv"], fetchFn, other, ENV, vi.fn().mockRejectedValue("falhou"))).resolves.toBe(1);
    expect(other).toHaveBeenCalledWith("Error: Não foi possível gravar o arquivo: erro desconhecido");
  });

  it("sem GAMESLIST_TOKEN não chama a API", async () => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(["export"], fetchFn, output, { GAMESLIST_API_URL: "http://api:8080" })).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Defina GAMESLIST_TOKEN com o token obtido no login.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("mostra erro claro com HTTP 401 e não grava arquivo", async () => {
    const output = vi.fn();
    const save = vi.fn();

    await expect(
      run(["export", "--output", "a.csv"], vi.fn().mockResolvedValue(new Response("{}", { status: 401 })), output, ENV, save),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Token ausente ou inválido (401). Faça login e atualize GAMESLIST_TOKEN.");
    expect(save).not.toHaveBeenCalled();
  });

  it("mostra erro claro com HTTP 400 (filtro inválido)", async () => {
    const output = vi.fn();

    await expect(
      run(["export", "--rating-min", "11"], vi.fn().mockResolvedValue(new Response("{}", { status: 400 })), output, ENV),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Parâmetros inválidos (400)"));
  });

  it("mostra erro com outros status HTTP", async () => {
    const output = vi.fn();

    await expect(run(["export"], vi.fn().mockResolvedValue(new Response("{}", { status: 500 })), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: export request failed with HTTP 500.");
  });

  it("mostra erro quando a API não responde", async () => {
    const output = vi.fn();

    await expect(run(["export"], vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Could not reach the API: ECONNREFUSED");
  });

  it("recusa opção desconhecida e opção sem valor", async () => {
    const fetchFn = vi.fn();
    const output = vi.fn();

    await expect(run(["export", "--limit", "5"], fetchFn, output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Unknown option: --limit");
    await expect(run(["export", "--output"], fetchFn, output, ENV)).resolves.toBe(1);
    expect(output).toHaveBeenCalledWith("Error: Option --output requires a value.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aparece na ajuda", async () => {
    const output = vi.fn();
    await run(["help"], vi.fn(), output, {});
    expect(String(output.mock.calls[0][0])).toContain("export [--q TEXT]");
    expect(String(output.mock.calls[0][0])).toContain("GAMESLIST_EXPORT_DIR");
  });
});

describe("saveFile", () => {
  it("cria as pastas que faltarem e grava o conteúdo em UTF-8", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gameslista-"));
    try {
      const path = join(dir, "sub", "pasta", "jogos.csv");
      await saveFile(path, "Ação,Aventura\r\n");
      await expect(readFile(path, "utf8")).resolves.toBe("Ação,Aventura\r\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
