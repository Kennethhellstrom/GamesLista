# GameList

Lista de jogos com **Web + CLI** sobre a mesma API REST e o mesmo banco (trabalho final de versionamento de código).

- **API:** Node.js + TypeScript (Express), que também serve a página Web (`index.html`)
- **Banco:** PostgreSQL 16
- **Tudo roda pelo Docker Compose.** No host só são necessários Docker, Docker Compose, um navegador e um terminal.

## Arquivos de produção

| Papel | Arquivo |
|---|---|
| Web | `index.html` (HTML, CSS e JavaScript embutidos) |
| API (rotas e inicialização) | `api.ts` |
| Handlers compartilhados da API | `api.handler.ts` |
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

A cobertura exigida é de **100% das linhas** de `api.ts`, `api.handler.ts`, `db.ts` e `cli.ts`. O comando falha se ficar abaixo disso. `index.html`, testes, infraestrutura e configuração não entram na cobertura.
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
## #4 Busca avançada

Na aba **Busca** (depois do login) há um formulário com **6 filtros combináveis**. Ao clicar em **Buscar**, a tabela é atualizada **sem recarregar a página** (consulta assíncrona), com as mesmas colunas da listagem mais o ano, **5 itens por página**, ordenação por coluna (▲/▼) e **Anterior/Próxima** sobre o resultado filtrado. **Limpar filtros** esvazia o formulário e volta à lista completa. Ao abrir a aba sem filtros, aparecem todos os jogos ativos.

### Filtros

Os filtros preenchidos se combinam com **AND**; os vazios são ignorados. Só jogos ativos (`active = 1`) entram no resultado.

| Parâmetro | Campo na tela | Regra |
|---|---|---|
| `q` | Título contém | O título contém o texto, sem diferenciar maiúsculas. `%` e `_` valem como texto comum |
| `platform` | Plataforma | Igual ao texto, sem diferenciar maiúsculas |
| `genre` | Gênero | Igual ao texto, sem diferenciar maiúsculas |
| `year_min` | Ano a partir de | Ano de lançamento **maior ou igual** (inclusivo) |
| `year_max` | Ano até | Ano de lançamento **menor ou igual** (inclusivo) |
| `rating_min` | Nota mínima | Nota **maior ou igual** (inclusivo), de 0 a 10 (até 2 casas decimais) |

Observações: acentos contam (`Ação` não casa com `Acao`); `platform` e `genre` têm sugestões na tela, mas aceitam qualquer texto; se o ano inicial for maior que o final, o resultado é vazio (a tela avisa antes de buscar).

### Endpoint

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/web/records/search` | Jogos ativos que atendem a todos os filtros enviados: `{"items","page","page_size","total"}` (mesmo formato da listagem) |

Exige `Authorization: Bearer <token>` (sem token, **401**). Além dos filtros acima, aceita `page`, `page_size` (padrão **5**, máximo 100), `sort` (`id` padrão, `title`, `platform`, `genre`, `rating`, `release_year`) e `order` (`asc` padrão ou `desc`). Valores inválidos respondem **400**: nota fora de 0 a 10 ou não numérica, ano que não seja inteiro positivo, texto com mais de 100 caracteres, parâmetro repetido, `sort`/`order`/`page`/`page_size` inválidos.

Os valores digitados **nunca são inseridos no texto do SQL**: vão sempre como parâmetros (`$1`, `$2`, ...). Só trechos fixos do `WHERE` e o campo de ordenação, escolhido de uma lista fixa em `db.ts`, compõem a consulta.

```bash
# TOKEN obtido no login, como no exemplo da issue #3
curl -s -G "http://localhost:8080/api/web/records/search" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "platform=PC" --data-urlencode "rating_min=9"          # 8 jogos
curl -s -G "http://localhost:8080/api/web/records/search" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "platform=PlayStation" --data-urlencode "year_min=2018" --data-urlencode "rating_min=9.4"   # 3 jogos
curl -s -G "http://localhost:8080/api/web/records/search" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=zelda" --data-urlencode "sort=rating" --data-urlencode "order=desc"
curl -i "http://localhost:8080/api/web/records/search?rating_min=11" -H "Authorization: Bearer $TOKEN"   # 400
curl -i "http://localhost:8080/api/web/records/search"                                                    # 401
```

Os números acima valem para o seed de 29 jogos (`GAMESLIST_SEED=true`, ver a issue #3).

### Logs

Cada busca gera linhas `db` (`search_records` e `count_search_records`) e `api` (`search_records`) com o **mesmo `request_id`**. Parâmetros inválidos geram `WARN` na API. Consulte com `docker compose logs api`:

```json
{"timestamp":"2026-11-15T13:22:25.657Z","level":"INFO","layer":"db","client":"web","operation":"search_records","status":"success","request_id":"req-0896c520-1142-4345-a0be-fa2258fa7499","message":"Busca de jogos concluída"}
{"timestamp":"2026-11-15T13:22:25.658Z","level":"INFO","layer":"db","client":"web","operation":"count_search_records","status":"success","request_id":"req-0896c520-1142-4345-a0be-fa2258fa7499","message":"Contagem da busca concluída"}
{"timestamp":"2026-11-15T13:22:25.658Z","level":"INFO","layer":"api","client":"web","operation":"search_records","status":"success","request_id":"req-0896c520-1142-4345-a0be-fa2258fa7499","message":"Busca devolvida (página 1)"}
```

### Testes

`tests/busca.db.test.ts` e `tests/busca.api.test.ts` cobrem cada filtro sozinho, combinações de 2, 3 e 6 filtros, resultado vazio, ordenação e paginação, tentativa de SQL injection, escape de `%` e `_`, parâmetros inválidos (400), 401, logs correlacionados e erro de banco (500). Execute com `docker compose run --rm tests`.
<!-- ===== #4 fim ===== -->

<!-- ===== #5 inicio: exportação CSV web (A) ===== -->
<!-- ===== #5 fim ===== -->

<!-- ===== #6 inicio: dashboard web (A) ===== -->
<!-- ===== #6 fim ===== -->

<!-- ===== #7 inicio: estrutura CLI (B) ===== -->
## #7 Endpoints da CLI

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/cli/health` | Pública | Healthcheck sem acesso ao banco |
| POST | `/api/cli/token` | Pública | Recebe `{"token":"..."}` e retorna 200 se o token de sessão for válido; 401 se estiver ausente ou for inválido |

O token é o mesmo emitido pelo login Web e é mantido em memória pela instância da API. A CLI usa `GAMESLIST_API_URL` para localizar a API; `health` verifica sua disponibilidade e `token --token <token>` valida um token.
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
