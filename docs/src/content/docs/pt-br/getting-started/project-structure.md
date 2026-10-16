---
title: Estrutura do projeto
description: Para que serve cada arquivo e pasta de um projeto quickservice.
sidebar:
  order: 5
---

Um projeto é um punhado de pastas com nomes fixos. Você escreve três delas, e o `build` escreve o resto. Este é o `my-api` depois de ganhar um endpoint próprio e um hook:

```text
my-api/
├── .env                       # variáveis de ambiente, lidas pelo Bun
├── .generated/                # escrita pelo build — não edite
│   ├── models.ts
│   ├── openapi.json
│   ├── routes.ts
│   ├── server.ts
│   └── types.ts
├── endpoints/
│   └── health/
│       └── get.ts             # GET /health
├── entities/
│   └── User.ts                # /users
├── hooks/
│   └── authorized.ts          # a tag @authorized
├── migrations/                # só SQLite, PostgreSQL e MongoDB
├── package.json
├── quickservice.config.ts
└── tsconfig.json
```

## `entities/`

Uma entidade por arquivo, com o nome do seu tipo: `entities/User.ts` exporta `User`. Cada entidade ganha suas rotas geradas e um repositório.

- **Uma subpasta é um schema do banco.** `entities/auth/Account.ts` pertence ao schema `auth` e é servida em `/auth/accounts`. Só é permitido um nível de pastas.
- **Enums compartilhados também podem ficar aqui.** Um arquivo que exporta só enums ou uniões de strings não é uma entidade; as entidades importam dele.

[Sua primeira entidade](/pt-br/getting-started/first-entity/) mostra uma passo a passo, e a [referência de tags JSDoc](/pt-br/reference/tags/) lista todas as regras que você pode adicionar.

## `endpoints/`

Suas próprias rotas, um arquivo por rota. As pastas formam o caminho e o nome do arquivo é o método (`get.ts`, `post.ts`, `put.ts`, `patch.ts` ou `delete.ts`). Uma pasta entre colchetes, como `[id]`, é um parâmetro do caminho.

```ts check title="endpoints/health/get.ts"
import type { Endpoint } from "@quickservice/core";

/**
 * @summary Health check
 * @authorized
 */
const handler: Endpoint<unknown, { ok: boolean }> = async () => {
  return { ok: true };
};

export default handler;
```

Um endpoint recebe os repositórios, a requisição e os controles da resposta, e retorna o corpo da resposta. Um arquivo com o mesmo método e caminho de uma rota gerada, como `endpoints/users/[id]/get.ts`, substitui essa rota.

## `hooks/`

Código que roda antes ou depois de uma rota. O nome do arquivo é o nome do hook, e você o aplica marcando uma entidade ou um endpoint com ele, como o `@authorized` acima.

```ts check title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservice/core";

export default definePreHook(async (_repos, req) => {
  if (!req.headers.get("authorization")) throw new HttpError(401, "Missing credentials");
});
```

Com esse hook, uma requisição sem o header é barrada antes de o endpoint rodar:

```bash
curl localhost:3000/health
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Missing credentials" } }
```

E uma com o header passa:

```bash
curl -H "authorization: Bearer token" localhost:3000/health
```

```json
{ "ok": true }
```

## `quickservice.config.ts`

A configuração do projeto: o banco de dados, mais configurações opcionais para o servidor, arquivos, armazenamento, profundidade do populate, migrações e a documentação da API.

```ts check title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
});
```

Todas as chaves estão na [referência de configuração](/pt-br/reference/config/).

## `.env`

Variáveis de ambiente, como `DATABASE_URL` ou `PORT`. O Bun carrega esse arquivo sozinho, e a configuração lê os valores por `process.env`. Deixe-o fora do controle de versão; o `init` já o coloca no `.gitignore`.

## `migrations/`

Criada por `quickservice migration add <Nome>`, com um arquivo por migração (`<timestamp>_<Nome>.ts`) e uma pasta `meta/` com os snapshots do modelo. Você as aplica com `quickservice migrate`. O banco em memória não tem migrações, então essa pasta não aparece no `my-api`. Veja a [referência da CLI](/pt-br/reference/cli/).

## `.generated/`

Tudo o que o `build` (e o `dev`) produz. Cada build atualiza a pasta no lugar e apaga os arquivos que não gera mais.

| Arquivo | Contém |
| --- | --- |
| `models.ts` | As entidades interpretadas que o runtime usa |
| `types.ts` | Um tipo por entidade, mais seus tipos `Create` e `Update` e o `Repositories` tipado |
| `routes.ts` | As rotas CRUD geradas, seus endpoints e os hooks deles |
| `openapi.json` | O documento OpenAPI servido em `/openapi.json` e `/docs` |
| `server.ts` | A entrada que sobe o servidor: `bun .generated/server.ts` |

Nunca edite esses arquivos; o próximo build os sobrescreve. Adicione `.generated/` ao `.gitignore`, já que o `init` não faz isso.

É o tipo `Repositories` que dá tipos a `repos.users` nos endpoints e hooks. A [referência de repositórios e consultas](/pt-br/reference/api/) cobre os métodos.

## Outros arquivos

- **`package.json`** tem as duas dependências do framework e os scripts `dev`, `build`, `migrate` e `start`.
- **`tsconfig.json`** inclui `.generated/**/*.ts`, para o editor enxergar os tipos gerados. O TypeScript ignora pastas cujo nome começa com ponto, a menos que um padrão cite os arquivos delas.
- **`uploads/`** aparece quando alguém envia um arquivo: é o armazenamento local padrão dos registros `File` e `Media`. Adicione-a ao `.gitignore` também.
- Com SQLite, o arquivo do banco (`data.db` por padrão) também fica na pasta do projeto.

## Próximo

Você tem uma API rodando e já se localiza no projeto. Continue com o [Tutorial](/pt-br/tutorial/), que monta um exemplo completo passo a passo.
