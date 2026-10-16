---
title: Configuração e logs
description: O arquivo de configuração, os adapters de banco, as variáveis de ambiente e os logs de requisição.
sidebar:
  order: 43
---

Um projeto tem um único arquivo de configuração, `quickservice.config.ts`, na raiz. A CLI o lê no `build`, no `dev` e nos comandos de migration, e o servidor o lê ao iniciar. A maioria das opções tem padrão, então muitas vezes a configuração tem só o banco.

## `quickservice.config.ts`

O arquivo exporta por padrão o resultado de `defineConfig`. `defineConfig` devolve o argumento sem mudanças; ela existe para o editor tipar e completar cada chave:

```ts check title="quickservice.config.ts"
import { defineConfig, postgresAdapter } from "@quickservice/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  server: { publicUrl: "https://api.example.com" },
  files: { maxSize: "20MB" },
  populate: { maxDepth: 3 },
});
```

`database` é a única chave obrigatória. Valores inválidos interrompem a CLI e o servidor com uma mensagem que cita a chave, por exemplo `Invalid server.port: expected an integer between 1 and 65535, got 70000`. Todas as chaves, com tipo e padrão, estão na [referência de configuração](/pt-br/reference/config/).

A configuração é TypeScript, então pode ler variáveis de ambiente, decidir com base nelas ou importar funções auxiliares. O servidor a resolve ao iniciar, não no build, então um mesmo build roda em qualquer ambiente.

## Adapters de banco

`database` recebe um de quatro adapters, todos exportados por `@quickservice/core`:

```ts check
import { memoryAdapter, mongodbAdapter, postgresAdapter, sqliteAdapter } from "@quickservice/core";

// Records live in memory and disappear on restart; no migrations.
export const memory = memoryAdapter();

// A SQLite file (created when missing), or ":memory:".
export const sqlite = sqliteAdapter({ path: process.env.DATABASE_PATH! });

// PostgreSQL, through Bun's SQL client.
export const postgres = postgresAdapter({ url: process.env.DATABASE_URL! });

// MongoDB; it must run as a replica set, because relation updates use transactions.
export const mongodb = mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! });
```

`quickservice init --db <banco>` escreve a configuração correspondente e um `.env` com as variáveis que ela lê.

## Variáveis de ambiente

O Bun carrega o `.env` da pasta do projeto, então os valores dele chegam ao `process.env` na configuração. O `init` coloca o `.env` no `.gitignore`; guarde os segredos ali ou nas configurações do seu provedor.

| Variável | Lida por | Efeito |
| --- | --- | --- |
| `DATABASE_URL` | a configuração escrita pelo `init` | URL de conexão do PostgreSQL e do MongoDB. |
| `DATABASE_NAME` | a configuração escrita pelo `init` | Nome do banco no MongoDB. |
| `DATABASE_PATH` | a configuração escrita pelo `init` | Caminho do arquivo SQLite. |
| `DATABASE_SCHEMA` | quickservice | Schema padrão do banco; tem prioridade sobre `schema` na configuração. Precisa seguir `^[a-z][a-z0-9-]*$`. |
| `PORT` | quickservice | Porta em que o servidor escuta quando `server.port` não está definido (padrão 3000). |
| `NODE_ENV` | quickservice | `production` liga o modo de produção quando `production` não está definido. |
| `FILES_SIGNING_SECRET` | quickservice | Segredo das URLs de arquivo assinadas quando `files.signingSecret` não está definido. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_ENDPOINT` | `s3Storage` | Credenciais, região e endpoint omitidos nas opções; as versões `AWS_*` também funcionam. |

Os nomes `DATABASE_*`, fora `DATABASE_SCHEMA`, são uma convenção da configuração gerada, não algo embutido: renomeie como quiser. `DATABASE_SCHEMA` permite que um mesmo build rode em um schema diferente por ambiente:

```bash
DATABASE_SCHEMA=staging bun run quickservice migrate
DATABASE_SCHEMA=staging bun .generated/server.ts
```

Um nome inválido interrompe o comando:

```text
Invalid DATABASE_SCHEMA: "Bad" must match ^[a-z][a-z0-9-]*$
```

### Modo de produção

`production` tem padrão `NODE_ENV === "production"`. Em produção:

- As respostas 500 escondem os detalhes do erro. Em desenvolvimento, elas trazem o stack:

```bash
curl localhost:3000/boom
```

```json
// 500 Internal Server Error, desenvolvimento
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","details":{"stack":"Error: Something broke\n    at handler (.../endpoints/boom/get.ts:2:13)\n    ..."}}}

// 500 Internal Server Error, produção
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}
```

- A [documentação da API](/pt-br/guides/api-docs/) fica desligada, a menos que `docs.enabled` seja `true`.
- `migrate` se recusa a reverter migrations sem `--force` (veja [Migrations](/pt-br/guides/migrations/)).

## Logs

O servidor escreve uma entrada de log por requisição, como uma linha JSON no stdout:

```json
{"level":"info","timestamp":"2026-10-16T22:25:19.256Z","requestId":"01a146d1-d595-77ea-8f13-a6c875a44b64","method":"DELETE","route":"/organizations/[id]","status":204,"durationMs":2.82,"hooks":[]}
```

| Chave | Descrição |
| --- | --- |
| `level` | `info` para status abaixo de 500, `error` para 500 ou mais. |
| `timestamp` | Momento da entrada, em ISO 8601. |
| `requestId` | O id da requisição (veja abaixo). |
| `method` | Método HTTP. |
| `route` | O padrão de rota encontrado, como `/users/[id]`, ou `null` quando nenhuma rota casou. |
| `status` | Status da resposta. |
| `durationMs` | Tempo para produzir a resposta. |
| `hooks` | Nomes dos hooks que rodaram. |

As entradas nunca trazem corpos, valores de query, valores de parâmetros de caminho ou cabeçalhos além do id da requisição, então podem ir para um serviço de logs com segurança.

Existem outros dois tipos de entrada. Um erro inesperado (qualquer coisa lançada que não seja um `HttpError`) vai para o log em `error` com nome, mensagem e stack, em qualquer modo, antes da entrada da requisição:

```json
{"level":"error","timestamp":"2026-10-16T22:37:22.964Z","requestId":"01a146dc-e094-7726-97ee-a516e0382876","error":{"name":"Error","message":"Something broke","stack":"Error: Something broke\n    at handler (.../endpoints/boom/get.ts:2:13)\n    ..."}}
```

E um arquivo guardado que não pôde ser apagado vai para o log em `warn` com `message: "File object not deleted"`, o `storage`, a `key` e o `error` (veja [Arquivos e armazenamento](/pt-br/guides/files/#limpeza)).

### Ids de requisição

Toda resposta tem um cabeçalho `x-request-id` com o id que aparece nos logs, e handlers e hooks o leem como `req.id`. Quando a requisição envia um `x-request-id` com 1 a 128 letras, dígitos, `_` ou `-`, o servidor o mantém; caso contrário, gera um UUID v7. Repasse o id do seu gateway ou frontend para acompanhar uma requisição entre serviços (`/health` é o endpoint da [documentação da API](/pt-br/guides/api-docs/#endpoints-personalizados)):

```bash
curl -i -H 'x-request-id: checkout-42' "localhost:3000/health?verbose=true"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
x-request-id: checkout-42
Content-Length: 33

{"status":"ok","uptimeSeconds":2}
```

```json
{"level":"info","timestamp":"2026-10-16T22:37:22.936Z","requestId":"checkout-42","method":"GET","route":"/health","status":200,"durationMs":0.723,"hooks":[]}
```

### Um logger próprio

`logger` recebe qualquer objeto com os métodos `info`, `warn` e `error`, cada um recebendo a entrada como objeto. Envie as entradas para a sua biblioteca de logs ou acrescente campos a elas. Esta configuração adiciona o nome do serviço e mantém as linhas JSON do `jsonLogger` padrão:

```ts check
import { defineConfig, jsonLogger, sqliteAdapter, type Logger } from "@quickservice/core";

const logger: Logger = {
  info: (entry) => jsonLogger.info({ service: "accounts", ...entry }),
  warn: (entry) => jsonLogger.warn({ service: "accounts", ...entry }),
  error: (entry) => jsonLogger.error({ service: "accounts", ...entry }),
};

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  logger,
});
```

```json
{"level":"info","service":"accounts","timestamp":"2026-10-16T22:37:22.974Z","requestId":"01a146dc-e09e-71d8-b329-7c5e571e7ca7","method":"GET","route":"/users/[id]","status":401,"durationMs":0.377,"hooks":["authorized"]}
```

Um erro lançado pelo logger nunca muda a resposta.

## Veja também

- [Referência de configuração](/pt-br/reference/config/): todas as chaves com tipo e padrão.
- [CLI](/pt-br/reference/cli/): os comandos que leem a configuração.

Próximo: [Receitas](/pt-br/recipes/).
