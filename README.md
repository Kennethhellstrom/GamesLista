# GameList

Lista de jogos com **Web + CLI** sobre a mesma API REST e o mesmo banco (trabalho final de versionamento de código).

- **API:** Node.js + TypeScript (Express), que também serve a página Web (`index.html`)
- **Banco:** PostgreSQL 16
- **Tudo roda pelo Docker Compose.** No host só são necessários Docker, Docker Compose, um navegador e um terminal.

## Arquivos de produção

| Papel | Arquivo |
|---|---|
| Web | `index.html` (HTML, CSS e JavaScript embutidos) |
| API | `api.ts` |
| Banco (inclui o `Logger`) | `db.ts` |
| CLI | `cli.ts` (entra na issue #7) |
| Documentação | `README.md` (uma seção por issue) |

Cada issue escreve apenas dentro do seu bloco `===== #N inicio/fim =====` nesses arquivos.

## Comandos

```bash
docker compose up --build                 # Web + API + banco (http://localhost:8080)
docker compose logs api                   # logs JSON
docker compose run --rm tests             # testes + cobertura de linhas (exige 100%)
docker compose run --rm cli <comando>     # CLI (a partir da #7)
```

<!-- ===== #1 inicio: estrutura web ===== -->
## #1 Como iniciar a Web

### Passo a passo

```bash
git clone <url-do-repositório>
cd <pasta-do-repositório>
cp .env.example .env          # opcional: ajuste os valores se quiser
docker compose up --build
```

Abra <http://localhost:8080>. Para parar, use `Ctrl+C`; para apagar também os dados do banco, `docker compose down -v`.

### Login

O usuário inicial é **configurável por variáveis de ambiente** (arquivo `.env`, que não é versionado) e é criado, ou tem a senha atualizada, toda vez que a API inicia:

| Variável | Descrição | Valor do `.env.example` (fictício) |
|---|---|---|
| `GAMESLIST_ADMIN_USER` | Usuário inicial | `admin` |
| `GAMESLIST_ADMIN_PASSWORD` | Senha do usuário inicial | `admin123` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Banco | `gamelist` |

Os valores acima são fictícios e servem só para desenvolvimento local. Sem `.env`, o Compose usa esses mesmos padrões.

Na página inicial, informe usuário e senha. Com credenciais corretas, aparece a tela inicial com as abas **Cadastro**, **Listagem**, **Busca** e **Dashboard** (preenchidas pelas próximas issues). Com credenciais erradas, aparece uma mensagem de erro.

A senha é guardada no banco apenas como hash (PBKDF2-SHA256 com salt) e nunca é escrita nos logs. O login devolve um token (32 bytes aleatórios, em memória) que a Web guarda em `sessionStorage` e envia como `Authorization: Bearer <token>`.

### Endpoints

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/` | Pública | Página inicial (`index.html`) |
| GET | `/api/web/health` | Pública | Healthcheck (HTTP 200) |
| POST | `/api/web/login` | Pública | Recebe `{"username","password"}` e devolve `{"token"}`; 401 se inválido |
| GET | `/api/web/me` | Bearer | Valida a sessão (a página usa ao abrir) |

Sem credenciais, ou com credenciais/token inválidos, a resposta é **HTTP 401**.

```bash
curl -i http://localhost:8080/api/web/health

curl -s -X POST http://localhost:8080/api/web/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

curl -i http://localhost:8080/api/web/me                                   # 401
curl -i http://localhost:8080/api/web/me -H "Authorization: Bearer <token>" # 200
```

### Banco

Ao iniciar, a API cria o esquema **completo** (para ninguém alterar esquema depois):

- `users`: `username`, `password_hash`, `salt`
- `games`: `id`, `title`, `platform`, `genre`, `release_year`, `rating`, `notes`, `active` (padrão 1), `created_at`

### Logs

Cada operação gera **uma linha JSON por evento** no stdout, nas camadas `api` e `db`, com o mesmo `request_id` (`req-<guid>`) na mesma requisição. Campos: `timestamp`, `level`, `layer`, `client`, `operation`, `status`, `request_id`, `message`.

```bash
docker compose logs api         # todos os logs
docker compose logs -f api      # acompanhando em tempo real
```

Exemplo de um login (duas linhas, mesmo `request_id`):

```json
{"timestamp":"2026-11-10T03:00:00.000Z","level":"INFO","layer":"db","client":"web","operation":"check_credentials","status":"success","request_id":"req-7c1f0b6e-0c3a-4d52-9d1e-5b7f2a9e1c44","message":"Consulta de credenciais concluída"}
{"timestamp":"2026-11-10T03:00:00.040Z","level":"INFO","layer":"api","client":"web","operation":"login","status":"success","request_id":"req-7c1f0b6e-0c3a-4d52-9d1e-5b7f2a9e1c44","message":"Login realizado com sucesso"}
```

Falhas de autenticação aparecem como `WARN` com `status: "error"`, sem expor senhas nem tokens.

### Testes e cobertura

```bash
docker compose run --rm tests                         # testes + cobertura de linhas
docker compose run --rm tests npm run typecheck       # verificação de tipos
```

A cobertura exigida é de **100% das linhas** de `api.ts`, `db.ts` (e `cli.ts` quando existir). O comando falha se ficar abaixo disso. `index.html`, testes, infraestrutura e configuração não entram na cobertura.
<!-- ===== #1 fim ===== -->

<!-- ===== #2 inicio: cadastro/edição web (B) ===== -->
<!-- ===== #2 fim ===== -->

<!-- ===== #3 inicio: listagem/exclusão web (C) ===== -->
## #3 Listagem e exclusão

Na aba **Listagem** (depois do login) os jogos aparecem em uma tabela com **4 campos visíveis** (título, plataforma, gênero e nota), **5 itens por página** e botões **Anterior/Próxima**. Os dados são carregados do banco ao abrir a página.

- **Ordenação:** clique no cabeçalho de uma coluna (▲ crescente, ▼ decrescente; novo clique inverte).
- **Seleção e exclusão:** marque os jogos nas caixas de seleção (a caixa do cabeçalho marca a página inteira) e use **Excluir selecionados**, que pede confirmação.
- **Exclusão lógica:** excluir não apaga a linha; o jogo passa a `active = 0` e deixa de aparecer. Toda listagem, contagem ou busca deve considerar só `active = 1`.

### Preparar dados (seed)

O banco começa vazio. Para popular com **29 jogos** de exemplo (7 gêneros, 5 plataformas, anos de 2000 a 2024, notas de 3,5 a 9,8), ligue o seed:

```bash
# no .env (copie de .env.example) ou direto no comando:
GAMESLIST_SEED=true docker compose up --build
```

O seed roda na inicialização da API e **não duplica**: se a tabela `games` já tiver linhas (inclusive as excluídas logicamente), nada é inserido. Por padrão (`GAMESLIST_SEED=false`) nenhum dado é criado. Para recomeçar do zero: `docker compose down -v`.

### Endpoints

Ambos exigem `Authorization: Bearer <token>` (sem token, **401**).

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/web/records?page=&page_size=&sort=&order=` | Página de jogos ativos: `{"items","page","page_size","total"}` |
| DELETE | `/api/web/records/{id}` | Exclusão lógica: **204**; **404** se não existir ou já estiver excluído |

Parâmetros do GET: `page` (padrão 1), `page_size` (padrão **5**, máximo 100), `sort` (`id` padrão, `title`, `platform`, `genre`, `rating`, `release_year`) e `order` (`asc` padrão ou `desc`). Valores inválidos respondem **400**. O campo de ordenação é escolhido de uma lista fixa em `db.ts`; o texto recebido nunca é inserido no SQL.

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/web/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

curl -s "http://localhost:8080/api/web/records?page=2&sort=rating&order=desc" -H "Authorization: Bearer $TOKEN"
curl -i -X DELETE http://localhost:8080/api/web/records/1 -H "Authorization: Bearer $TOKEN"   # 204
curl -i -X DELETE http://localhost:8080/api/web/records/1 -H "Authorization: Bearer $TOKEN"   # 404 (já excluído)
curl -i http://localhost:8080/api/web/records                                                 # 401
```

### Logs

Cada requisição gera linhas `db` (`list_records`, `count_records`, `delete_record`) e `api` com o **mesmo `request_id`**. Consulte com `docker compose logs api`:

```json
{"timestamp":"2026-11-13T18:00:00.000Z","level":"INFO","layer":"db","client":"web","operation":"list_records","status":"success","request_id":"req-0b1d6c1e-7a52-4c1e-9a43-2f8e5d6a7b10","message":"Listagem de jogos concluída"}
{"timestamp":"2026-11-13T18:00:00.004Z","level":"INFO","layer":"db","client":"web","operation":"count_records","status":"success","request_id":"req-0b1d6c1e-7a52-4c1e-9a43-2f8e5d6a7b10","message":"Contagem de jogos concluída"}
{"timestamp":"2026-11-13T18:00:00.006Z","level":"INFO","layer":"api","client":"web","operation":"list_records","status":"success","request_id":"req-0b1d6c1e-7a52-4c1e-9a43-2f8e5d6a7b10","message":"Listagem devolvida (página 1)"}
```

### Testes

`tests/listagem.db.test.ts` e `tests/listagem.api.test.ts` cobrem paginação (primeira, última, `page_size`), ordenação asc/desc, campo inválido, exclusão ok/404, 401 e seed idempotente. Execute com `docker compose run --rm tests`.
<!-- ===== #3 fim ===== -->

<!-- ===== #4 inicio: busca web (C) ===== -->
<!-- ===== #4 fim ===== -->

<!-- ===== #5 inicio: exportação CSV web (A) ===== -->
<!-- ===== #5 fim ===== -->

<!-- ===== #6 inicio: dashboard web (A) ===== -->
<!-- ===== #6 fim ===== -->

<!-- ===== #7 inicio: estrutura CLI (B) ===== -->
<!-- ===== #7 fim ===== -->

<!-- ===== #8 inicio: cadastro/edição CLI (A) ===== -->
<!-- ===== #8 fim ===== -->

<!-- ===== #9 inicio: listagem/exclusão CLI (C) ===== -->
<!-- ===== #9 fim ===== -->

<!-- ===== #10 inicio: busca CLI (B) ===== -->
<!-- ===== #10 fim ===== -->

<!-- ===== #11 inicio: exportação CSV CLI (C) ===== -->
<!-- ===== #11 fim ===== -->

<!-- ===== #12 inicio: indicadores CLI (B) ===== -->
<!-- ===== #12 fim ===== -->
