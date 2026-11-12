# GamesLista

## #7 Como usar a CLI

A CLI em TypeScript é empacotada em um contêiner Docker e pode ser executada com Docker Compose. A API e a autenticação da CLI dependem da issue #1 e ainda não fazem parte deste esqueleto; por isso, somente `help` funciona até que essa base esteja disponível.

Para configurar as variáveis de ambiente do Docker Compose, copie o arquivo de exemplo:

```sh
cp .env.example .env
```

Edite `.env` para substituir `GAMESLIST_API_URL` ou informar um `GAMESLIST_TOKEN`, se necessário.

```sh
docker compose run --rm cli help
```

Quando a API da issue #1 estiver disponível, os comandos abaixo consultarão a API em `http://api:8080` por padrão:

```sh
docker compose run --rm cli health
docker compose run --rm cli token --user "usuario" --password "senha"
```

O comando `token` imprime o token obtido. Para disponibilizá-lo aos comandos autenticados que serão adicionados pelas próximas issues, configure `GAMESLIST_TOKEN` no shell:

```powershell
$env:GAMESLIST_TOKEN = "<token>"
```

Em shells POSIX, use `export GAMESLIST_TOKEN="<token>"`. A URL da API pode ser substituída pela variável `GAMESLIST_API_URL`. A CLI não se conecta diretamente ao banco de dados.

Para executar os testes e verificar a cobertura de linhas:

```sh
npm ci
npm run test:coverage
```
