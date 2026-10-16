---
title: Schemas multi-tenant
description: Dê a cada deploy seu próprio schema do banco com DATABASE_SCHEMA, e agrupe entidades em schemas explícitos com pastas ou @schema.
sidebar:
  order: 20
---

Você roda a mesma API para vários clientes e quer os dados de cada um separados, no mesmo servidor de banco, sem um segundo build. Ou quer algumas entidades, como contas, num schema só delas. O quickservice tem duas ferramentas para isso:

| | Schema padrão | Schema explícito |
| --- | --- | --- |
| Definido com | `DATABASE_SCHEMA`, ou `schema` na configuração | Uma pasta em `entities/`, ou `@schema` |
| Decidido | Quando o servidor ou o `migrate` inicia | No build |
| Vale para | Toda entidade sem schema explícito | Só aquela entidade |
| Rotas e repositórios | Iguais: `/users`, `repos.users` | Com prefixo: `/auth/users`, `repos.auth.users` |

## Um schema por tenant: `DATABASE_SCHEMA`

Escreva as entidades como sempre:

```ts check title="entities/Project.ts"
export type Project = {
  name: string;
};
```

Faça o build e crie a migration uma vez:

```bash
bun run quickservice migration add Initial
```

Depois dê a cada deploy seu próprio `DATABASE_SCHEMA`, para o `migrate` e para o servidor:

```bash
DATABASE_SCHEMA=tenant-a bun run quickservice migrate
# Applied 20261016223339_Initial
DATABASE_SCHEMA=tenant-b bun run quickservice migrate
# Applied 20261016223339_Initial

DATABASE_SCHEMA=tenant-a PORT=3001 bun run start
DATABASE_SCHEMA=tenant-b PORT=3002 bun run start
```

Os dois servidores expõem as mesmas rotas, e cada um só vê os próprios registros:

```bash
curl -X POST localhost:3001/projects -d '{"name":"Apollo"}'
# {"id":"01a146d9-8401-773d-bb02-bedd394aaf98","createdAt":"2026-10-16T22:33:42.658Z","updatedAt":"2026-10-16T22:33:42.658Z","name":"Apollo"} (201)
curl localhost:3001/projects
# {"data":[{"id":"01a146d9-8401-773d-bb02-bedd394aaf98","createdAt":"2026-10-16T22:33:42.658Z","updatedAt":"2026-10-16T22:33:42.658Z","name":"Apollo"}],"total":1,"limit":20,"offset":0}
curl localhost:3002/projects
# {"data":[],"total":0,"limit":20,"offset":0}
```

O schema padrão é resolvido quando o processo inicia e nunca é gravado em `.generated/` nem em `migrations/`, então um build e um conjunto de arquivos de migration servem todos os tenants. Num deploy, defina `DATABASE_SCHEMA` como qualquer outra variável de ambiente, ou no `.env` do projeto, que o Bun carrega.

Para definir um padrão para todos os ambientes, coloque `schema` na configuração; `DATABASE_SCHEMA` continua vencendo quando está definido (um valor vazio conta como não definido):

```ts check title="quickservice.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  schema: "app",
});
```

O padrão resolvido é `DATABASE_SCHEMA`, senão `schema`, senão nenhum, o que significa o padrão do próprio banco (`public` no PostgreSQL, tabelas sem prefixo no SQLite).

### Onde cada banco guarda

Um hífen no nome vira sublinhado no banco, então `tenant-a` é guardado como `tenant_a`.

| Banco | `DATABASE_SCHEMA=tenant-a` | Sem schema padrão |
| --- | --- | --- |
| PostgreSQL | Schema `tenant_a` (criado se não existir), usado via `search_path`: tabela `tenant_a.projects` | `public.projects` |
| SQLite | Prefixo no nome da tabela: `tenant_a__projects` | `projects` |
| MongoDB | Banco `tenant_a` | O banco da configuração do adapter (`DATABASE_NAME`) |
| Memória | Sem efeito: cada processo tem seus próprios registros | — |

Cada tenant também tem seu próprio histórico de migrations (no SQLite, `tenant_a____quickservice_migrations`), então migrar um tenant nunca marca uma migration como aplicada para outro. No SQLite, os arquivos de migration guardam um marcador nas tabelas do schema padrão, que o `migrate` substitui:

```sql
CREATE TABLE `{{default_schema}}projects` (...)
```

## Entidades num schema próprio: pastas e `@schema`

Um arquivo numa pasta de `entities/` pertence ao schema com o nome da pasta. Aqui `entities/auth/User.ts` fica no schema `auth`, ao lado de um `User` do schema padrão que o referencia:

```ts check title="entities/auth/User.ts"
export type User = {
  /** @unique */
  email: string;
};
```

```ts check title="entities/User.ts"
import type { User as Account } from "./auth/User.ts";

export type User = {
  /** @unique */
  email: string;
  account?: Account;
};
```

`@schema` define o schema sem pasta, e vence a pasta quando os dois existem:

```ts check title="entities/Invoice.ts"
/** @schema billing-eu */
export type Invoice = {
  number: string;
};
```

Entidades com schema recebem o schema como prefixo das rotas:

```bash
curl -X POST localhost:3000/auth/users -d '{"email":"ana@x.co"}'
# {"id":"01a146d8-6bab-70b9-99e3-c70fac60daf0","createdAt":"2026-10-16T22:32:30.892Z","updatedAt":"2026-10-16T22:32:30.892Z","email":"ana@x.co"} (201)
curl -X POST localhost:3000/users -d '{"email":"ana@x.co","account":"01a146d8-6bab-70b9-99e3-c70fac60daf0"}'
# {"id":"01a146d8-6bdd-704a-9110-4ea6f9e5db31","createdAt":"2026-10-16T22:32:30.941Z","updatedAt":"2026-10-16T22:32:30.941Z","email":"ana@x.co","account":"01a146d8-6bab-70b9-99e3-c70fac60daf0"} (201)
curl -X POST localhost:3000/billing-eu/invoices -d '{"number":"2026-001"}'
# {"id":"01a146d8-6c01-740c-8aab-4f75236469dd","createdAt":"2026-10-16T22:32:30.977Z","updatedAt":"2026-10-16T22:32:30.977Z","number":"2026-001"} (201)
```

As duas coleções `users` aceitam `ana@x.co`, porque cada schema tem suas próprias tabelas e seus próprios índices únicos. Referências funcionam entre schemas, inclusive `@onDelete`:

```bash
curl -X DELETE localhost:3000/auth/users/01a146d8-6bab-70b9-99e3-c70fac60daf0
# {"error":{"code":"CONFLICT","message":"Cannot delete: referenced by users"}} (409)
```

### Repositórios e tipos

Em endpoints e hooks, o repositório de uma entidade com schema fica sob a chave do schema, que é o nome do schema em camelCase: `repos.auth.users`, `repos.billingEu.invoices`. Quando dois schemas têm uma entidade com o mesmo nome de tipo, o tipo gerado da que tem schema recebe o schema como prefixo, então `entities/auth/User.ts` vira `AuthUser` em `.generated/types.ts`.

`endpoints/accounts/get.ts`, que serve `GET /accounts?email=...`:

```ts check title="endpoints/accounts/get.ts"
import { HttpError, type Endpoint } from "@quickservice/core";

/** @summary Find an account by email */
const handler: Endpoint = async (repos, req) => {
  const email = req.query.get("email") ?? "";
  const account = await repos.auth.users.findOne([{ field: "email", op: "eq", value: email }]);
  if (!account) throw new HttpError(404, "Account not found");
  return account;
};

export default handler;
```

```bash
curl "localhost:3000/accounts?email=ana@x.co"
# {"id":"01a146d8-6bab-70b9-99e3-c70fac60daf0","createdAt":"2026-10-16T22:32:30.892Z","updatedAt":"2026-10-16T22:32:30.892Z","email":"ana@x.co"}
curl "localhost:3000/accounts?email=bob@x.co"
# {"error":{"code":"NOT_FOUND","message":"Account not found"}} (404)
```

<details>
<summary>A parte de <code>.generated/types.ts</code> que tipa <code>repos.auth</code></summary>

```ts check title=".generated/types.ts"
// Generated by quickservice build. Do not edit. (Excerpt.)
import type { Repository } from "@quickservice/core";

export type AuthUser = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
};

export type AuthUserCreate = {
  email: string;
};

export type AuthUserUpdate = {
  email?: string;
};

export type AuthUserReferences = Record<never, never>;

export interface GeneratedRepositories {
  auth: {
    users: Repository<AuthUser, AuthUserReferences, AuthUserCreate, AuthUserUpdate>;
  };
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

Para substituir uma rota gerada de uma entidade com schema, coloque o endpoint no caminho com prefixo: `endpoints/auth/users/[id]/get.ts` substitui `GET /auth/users/:id`. Na documentação da API, a tag da entidade é `auth/users`.

### Onde cada banco guarda

| Banco | `auth/users` |
| --- | --- |
| PostgreSQL | Tabela `users` no schema `auth`; a migration começa com `CREATE SCHEMA IF NOT EXISTS "auth"` |
| SQLite | Tabela `auth__users` |
| MongoDB | Coleção `users` no banco `auth` |
| Memória | Um namespace próprio, separado de `users` |

Os nomes de índices incluem o schema para continuarem únicos, como `auth_users_email_uq` ao lado de `users_email_uq`. Os arquivos de uma entidade de arquivo com schema são guardados com chaves que começam pelo schema (`auth/...`).

## Migrations

Um `migration add` cobre todos os schemas. No SQLite, a migration das entidades acima executa estes comandos (colunas omitidas):

```sql
CREATE TABLE `billing_eu__invoices` (...);
CREATE TABLE `{{default_schema}}users` (..., FOREIGN KEY (`account`) REFERENCES `auth__users`(`id`) ON UPDATE no action ON DELETE restrict);
CREATE UNIQUE INDEX `{{default_schema}}users_email_uq` ON `{{default_schema}}users` (`email`);
CREATE TABLE `auth__users` (...);
CREATE UNIQUE INDEX `auth_users_email_uq` ON `auth__users` (`email`);
```

Tabelas de schemas explícitos têm nomes fixos; só as tabelas do schema padrão seguem o `DATABASE_SCHEMA`.

No MongoDB, uma migration chega ao banco de cada schema por `ctx.db`: `ctx.db("auth")` é o banco `auth` e `ctx.db()` é o padrão, que é o banco do tenant quando `DATABASE_SCHEMA` está definido.

```ts check title="migrations/20261016120000_VerifyAccounts.ts"
import type { MongoMigrationContext } from "@quickservice/core";

export async function up(ctx: MongoMigrationContext): Promise<void> {
  await ctx.db("auth").collection("users").updateMany({}, { $set: { verified: false } });
}

export async function down(ctx: MongoMigrationContext): Promise<void> {
  await ctx.db("auth").collection("users").updateMany({}, { $unset: { verified: "" } });
}
```

:::caution[Schemas explícitos são compartilhados por todos os tenants]
Um schema explícito é o mesmo em todo deploy: todos os tenants leem e gravam o mesmo `auth/users`. Nos bancos SQL o histórico de migrations fica no schema padrão de cada tenant, então migrar um segundo tenant no mesmo banco tenta criar de novo as tabelas compartilhadas e falha:

```bash
DATABASE_SCHEMA=tenant-b bun run quickservice migrate
# Migration 20261016222536_Initial failed: table `billing_eu__invoices` already exists
```

Use schemas explícitos para dados que são mesmo compartilhados e, no SQLite e no PostgreSQL, migre-os a partir de um único deploy, ou dê a cada tenant seu próprio banco.
:::

## Regras de nome

Nomes de schema, vindos de pastas, `@schema`, `schema` ou `DATABASE_SCHEMA`, precisam seguir `^[a-z][a-z0-9-]*$`: minúsculas, começando por letra, com dígitos e hífens. Erros param o build ou a inicialização com uma mensagem que aponta o problema:

```
entities/Bad.ts: schema "Billing" must match ^[a-z][a-z0-9-]*$
entities/a/b: entities may only be nested one folder deep
entities/Bad.ts and entities/auth/User.ts collide: collection "auth" has the same name as schema "auth"
Invalid DATABASE_SCHEMA: "Bad" must match ^[a-z][a-z0-9-]*$
```

A última regra existe porque `/auth` seria ao mesmo tempo a rota de uma coleção e o prefixo de um schema. Duas entidades só podem ter o mesmo nome de tipo ou de coleção em schemas diferentes.

## Variações

### Uploads separados por tenant

O schema padrão não muda as chaves de storage das entidades de arquivo do schema padrão, então os tenants compartilham a pasta `uploads/` a menos que você a divida. A configuração é um módulo, então ela também pode ler a variável:

```ts check
import { defineConfig, localStorage, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  storage: { default: localStorage({ dir: `uploads/${process.env.DATABASE_SCHEMA || "shared"}` }) },
});
```

### Um arquivo de banco por tenant no SQLite

No SQLite você também pode dispensar schemas e apontar cada deploy para seu próprio arquivo, `DATABASE_PATH=tenant-a.db`. Assim os schemas explícitos deixam de ser compartilhados entre tenants.

## Relacionados

- [`@schema`](/pt-br/reference/tags/#schema) e as outras tags de entidade
- [Configuração: `schema`](/pt-br/reference/config/)
- [CLI: `migrate` e `migration add`](/pt-br/reference/cli/#migrate)
- [API do repositório](/pt-br/reference/api/)

Anterior: [Paginação em endpoints customizados](/pt-br/recipes/pagination/). Próxima: [Testando sua API no mesmo processo](/pt-br/recipes/testing/).
