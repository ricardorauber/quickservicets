---
title: Checagem de permissões
description: Um hook authorized reutilizável que checa um papel ou uma permissão, e um endpoint que responde "este usuário pode fazer isso?".
sidebar:
  order: 10
---

**O problema:** algumas rotas são só para admins, outras para quem tem uma permissão como `billing:manage`, e um front end quer perguntar se um usuário pode fazer algo antes de mostrar um botão. Você quer uma checagem só, escrita uma vez, que toda entidade e todo endpoint reutilizem com uma tag.

**A solução:** um pre-hook chamado `authorized` que lê o token bearer, carrega o usuário e checa o papel ou a permissão escritos na tag, mais uma pequena função auxiliar que reúne as permissões de um usuário com uma [consulta fluente](/pt-br/reference/api/#query) e `include`.

## O modelo

Permissões pertencem a módulos (`billing`, `reports`), perfis agrupam permissões e usuários têm perfis. `manage` também concede `view`, e um módulo inativo não concede nada.

```ts check title="entities/Module.ts"
/** @authorized admin */
export type Module = {
  /** @unique */
  slug: string;
  active: boolean;
};
```

```ts check title="entities/Permission.ts"
import type { Module } from "./Module";

/** @authorized admin */
export type Permission = {
  module: Module;
  action: "manage" | "view";
};
```

```ts check title="entities/Profile.ts"
import type { Permission } from "./Permission";

/** @authorized admin */
export type Profile = {
  /** @unique */
  slug: string;
  permissions: Permission[];
};
```

```ts check title="entities/User.ts"
import type { Profile } from "./Profile";

/** @authorized admin */
export type User = {
  /** @unique @format email */
  email: string;
  /**
   * SHA-256 hash of the user's API token; the token itself is never stored.
   * @unique @hidden
   */
  tokenHash: string;
  /** @default 'member' */
  role: "member" | "admin";
  profiles: Profile[];
};
```

A entidade que as permissões protegem: qualquer um lê faturas, mas gravá-las exige `billing:manage`.

```ts check title="entities/Invoice.ts"
/** @authorized:create,update,replace,delete billing:manage */
export type Invoice = {
  /** @unique */
  number: string;
  /** @min 0 */
  total: number;
};
```

O caminho `profiles.permissions.module` tem três segmentos, um a mais que o padrão de [`populate.maxDepth`](/pt-br/reference/config/):

```ts check title="quickservice.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  // "profiles.permissions.module" has three segments.
  populate: { maxDepth: 3 },
});
```

<details>
<summary>Os tipos gerados de que estes trechos dependem (trecho de <code>.generated/types.ts</code>)</summary>

O build escreve este arquivo para você; ele aparece aqui para que os trechos desta página passem na checagem de tipos sozinhos.

```ts check title=".generated/types.ts"
import type { Many, One, Repository } from "@quickservice/core";

export type Module = { id: string; createdAt: Date; updatedAt: Date; slug: string; active: boolean };
export type ModuleReferences = Record<never, never>;

export type Permission = { id: string; createdAt: Date; updatedAt: Date; module: string; action: "manage" | "view" };
export type PermissionReferences = { module: One<Module, ModuleReferences> };

export type Profile = { id: string; createdAt: Date; updatedAt: Date; slug: string; permissions: Array<string> };
export type ProfileReferences = { permissions: Many<Permission, PermissionReferences> };

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  tokenHash: string;
  role: "member" | "admin";
  profiles: Array<string>;
};
export type UserCreate = { email: string; tokenHash: string; role?: "member" | "admin"; profiles?: Array<string> };
export type UserUpdate = Partial<UserCreate>;
export type UserReferences = { profiles: Many<Profile, ProfileReferences> };

export type Invoice = { id: string; createdAt: Date; updatedAt: Date; number: string; total: number };

export interface GeneratedRepositories {
  modules: Repository<Module, ModuleReferences>;
  permissions: Repository<Permission, PermissionReferences>;
  profiles: Repository<Profile, ProfileReferences>;
  users: Repository<User, UserReferences, UserCreate, UserUpdate>;
  invoices: Repository<Invoice>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

## A função de permissões

Uma função responde "o que este usuário pode fazer?", então o hook e o endpoint abaixo concordam. Ela carrega o usuário com todos os perfis, permissões e módulos em uma consulta, e falha com 404 `User not found` quando o id não existe.

```ts check title="lib/permissions.ts"
import type { Repositories } from "@quickservice/core";

/** Every `<module>:<action>` the user's profiles grant; `manage` also grants `view`, inactive modules grant nothing. */
export async function grantedPermissions(repos: Repositories, userId: string): Promise<Set<string>> {
  const user = await repos.users
    .where((u) => u.id.eq(userId))
    .include("profiles.permissions.module")
    .first();
  const granted = new Set<string>();
  for (const { module, action } of user.profiles.flatMap((profile) => profile.permissions)) {
    if (!module?.active) continue;
    granted.add(`${module.slug}:view`);
    if (action === "manage") granted.add(`${module.slug}:manage`);
  }
  return granted;
}

/** The value stored in `User.tokenHash` for an API token. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
```

## O hook

Os argumentos da tag dizem o que a rota exige:

- `@authorized`: qualquer usuário autenticado.
- `@authorized admin`: usuários com esse papel.
- `@authorized billing:manage`: usuários com essa permissão.
- Vários argumentos (`@authorized billing:manage,reports:view`): basta um.

Admins passam em toda checagem. O hook guarda o usuário em `req.context.user`, para que hooks seguintes e o handler o usem.

```ts check title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservice/core";
import { grantedPermissions, hashToken } from "../lib/permissions.ts";

export default definePreHook(
  async (repos, req, _res, args) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token) throw new HttpError(401, "Authentication required");
    const user = await repos.users.where((u) => u.tokenHash.eq(hashToken(token))).firstOrDefault();
    if (!user) throw new HttpError(401, "Invalid token");
    req.context.user = user;

    if (args.length === 0 || user.role === "admin" || args.includes(user.role)) return;
    const wanted = args.filter((arg) => arg.includes(":"));
    if (wanted.length > 0) {
      const granted = await grantedPermissions(repos, user.id);
      if (wanted.some((permission) => granted.has(permission))) return;
    }
    throw new HttpError(403, "Not allowed");
  },
  { docs: { responses: [401, 403], security: "bearer" } },
);
```

`docs` acrescenta as respostas 401 e 403 e o esquema de segurança bearer a toda operação que usa o hook, então a documentação da API mostra o cadeado e os [corpos de erro](/pt-br/reference/errors/).

## O endpoint de checagem de permissões

`GET /users/:userId/has-permissions?p=billing:manage&p=reports:view` responde se um usuário tem as permissões, e quais faltam. Seus [itens de query tipados](/pt-br/reference/http/) são convertidos e validados antes de o handler rodar; só admins podem perguntar.

```ts check title="endpoints/users/[userId]/has-permissions/get.ts"
import type { Endpoint } from "@quickservice/core";
import { grantedPermissions } from "../../../../lib/permissions.ts";

type Query = {
  /** Permissions as `<module>:<action>`, e.g. `billing:manage`; repeat the key for each one. */
  p: string[];
  /**
   * `all`: every permission is needed; `any`: one is enough.
   * @default 'all'
   */
  rule?: "all" | "any";
};

type Answer = { allowed: boolean; missing: string[] };

/**
 * @summary Check a user's permissions
 * @authorized admin
 */
const handler: Endpoint<Query, Answer> = async (repos, req) => {
  const { p, rule } = req.queryItems;
  const granted = await grantedPermissions(repos, req.params.userId!);
  const missing = p.filter((permission) => !granted.has(permission));
  const allowed = rule === "any" ? missing.length < p.length : missing.length === 0;
  return { allowed, missing };
};

export default handler;
```

## O primeiro admin

Toda rota que gerencia acesso agora é só para admins, então crie o primeiro admin fora da API, por exemplo em uma migration que lê o token do ambiente:

```ts check title="migrations/20261016120000_SeedAdmin.ts"
import type { MigrationContext } from "@quickservice/core";
import { hashToken } from "../lib/permissions.ts";

export async function up(ctx: MigrationContext): Promise<void> {
  await ctx.repos.users.create({ email: "ana@acme.co", tokenHash: hashToken(process.env.ADMIN_TOKEN!), role: "admin" });
}

export async function down(ctx: MigrationContext): Promise<void> {
  const admin = await ctx.repos.users.where((u) => u.email.eq("ana@acme.co")).firstOrDefault();
  if (admin) await ctx.repos.users.delete(admin.id);
}
```

## Experimente

As requisições abaixo usam Ana, a admin (token `ana-secret`), e Bruno, um membro (token `bruno-secret`) cujo perfil `finance` concede `billing:manage`. Ana criou o módulo `billing`, sua permissão `manage` e o perfil `finance` com as rotas geradas, e depois Bruno, enviando o SHA-256 do token dele (`echo -n bruno-secret | shasum -a 256`):

```bash
curl -i -X POST localhost:3000/users -H "Authorization: Bearer ana-secret" \
  -d '{"email":"bruno@acme.co","tokenHash":"ca0a9db2204c4c84cb6ba3d96a7bdaf319eb89afa52e5b43c0f19b19097b6e1d","profiles":["01a146d9-b62f-7493-839f-f1dc2e8a759b"]}'
```

```txt
HTTP/1.1 201 Created

{"email":"bruno@acme.co","profiles":["01a146d9-b62f-7493-839f-f1dc2e8a759b"],"role":"member","id":"01a146d9-b630-73b2-ad4b-ac46a31ca6a5","createdAt":"2026-10-16T22:33:55.504Z","updatedAt":"2026-10-16T22:33:55.504Z"}
```

`tokenHash` é `@hidden`, então nunca volta na resposta.

Sem token, o hook para a requisição antes do handler:

```bash
curl -i -X POST localhost:3000/invoices -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 401 Unauthorized

{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

Um token que não corresponde a nenhum usuário também dá 401:

```bash
curl -i -X POST localhost:3000/invoices -H "Authorization: Bearer nope" -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 401 Unauthorized

{"error":{"code":"UNAUTHORIZED","message":"Invalid token"}}
```

Bruno tem `billing:manage`, então pode criar faturas:

```bash
curl -i -X POST localhost:3000/invoices -H "Authorization: Bearer bruno-secret" \
  -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 201 Created

{"number":"2026-001","total":120,"id":"01a146d9-b631-700b-81dc-90cdcd2b1cdd","createdAt":"2026-10-16T22:33:55.505Z","updatedAt":"2026-10-16T22:33:55.505Z"}
```

A leitura não tem a tag, então dispensa token:

```bash
curl localhost:3000/invoices
```

```json
{"data":[{"id":"01a146d9-b631-700b-81dc-90cdcd2b1cdd","createdAt":"2026-10-16T22:33:55.505Z","updatedAt":"2026-10-16T22:33:55.505Z","number":"2026-001","total":120}],"total":1,"limit":20,"offset":0}
```

Mas gerenciar usuários é só para admins:

```bash
curl -i -X POST localhost:3000/users -H "Authorization: Bearer bruno-secret" \
  -d '{"email":"carla@acme.co","tokenHash":"..."}'
```

```txt
HTTP/1.1 403 Forbidden

{"error":{"code":"FORBIDDEN","message":"Not allowed"}}
```

Ana pergunta o que Bruno pode fazer. `manage` também concede `view`, e nada concede `reports:view`:

```bash
curl "localhost:3000/users/01a146d9-b630-73b2-ad4b-ac46a31ca6a5/has-permissions?p=billing:view&p=reports:view" \
  -H "Authorization: Bearer ana-secret"
```

```json
{"allowed":false,"missing":["reports:view"]}
```

Com `rule=any`, basta uma permissão concedida:

```bash
curl "localhost:3000/users/01a146d9-b630-73b2-ad4b-ac46a31ca6a5/has-permissions?p=billing:view&p=reports:view&rule=any" \
  -H "Authorization: Bearer ana-secret"
```

```json
{"allowed":true,"missing":["reports:view"]}
```

Os itens de query são checados antes de o handler rodar, e um usuário desconhecido dá 404:

```bash
curl -i "localhost:3000/users/01a146d9-b630-73b2-ad4b-ac46a31ca6a5/has-permissions?rule=some" -H "Authorization: Bearer ana-secret"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"p","message":"Is required"},{"field":"rule","message":"Must be one of: all, any"}]}}
```

```bash
curl -i "localhost:3000/users/01a10000-0000-7000-8000-000000000000/has-permissions?p=billing:view" \
  -H "Authorization: Bearer ana-secret"
```

```txt
HTTP/1.1 404 Not Found

{"error":{"code":"NOT_FOUND","message":"User not found"}}
```

Em `/openapi.json`, toda operação que roda o hook o lista, com seus erros e o esquema de segurança:

```bash
curl -s localhost:3000/openapi.json | jq '.paths["/invoices"].post | {description, "x-hooks", security, responses: (.responses | keys)}'
```

```json
{
  "description": "Hooks: authorized(billing:manage)",
  "x-hooks": [{ "name": "authorized", "phase": "pre", "args": ["billing:manage"] }],
  "security": [{ "bearerAuth": [] }],
  "responses": ["201", "400", "401", "403", "409"]
}
```

`components.securitySchemes.bearerAuth` é `{ "type": "http", "scheme": "bearer" }`, então a página de documentação em `/docs` deixa você colar um token uma vez e enviá-lo em toda requisição.

## Variações

**Ler o usuário atual em um handler.** O hook guardou o usuário em `req.context`, então um endpoint `GET /me` tem poucas linhas:

```ts check title="endpoints/me/get.ts"
import type { Endpoint } from "@quickservice/core";
import type { User } from "../../.generated/types.ts";

/**
 * @summary The signed-in user
 * @authorized
 */
const handler: Endpoint<unknown, { id: string; email: string; role: string }> = async (_repos, req) => {
  const user = req.context.user as User;
  return { id: user.id, email: user.email, role: user.role };
};

export default handler;
```

```bash
curl localhost:3000/me -H "Authorization: Bearer bruno-secret"
```

```json
{"id":"01a146d9-b630-73b2-ad4b-ac46a31ca6a5","email":"bruno@acme.co","role":"member"}
```

**Só algumas operações.** Limite a tag a operações, como `Invoice` faz: `@authorized:create,update,replace,delete billing:manage`. Um hook só pode aparecer uma vez por entidade, então ponha a regra mais rígida nas operações que precisam dela.

**Permissões por organização.** Quando as permissões dependem de uma organização, como em um app multi-tenant, acrescente um item de query `organization` e procure as associações ativas do usuário nela: `repos.memberships.where((m) => m.user.eq(userId).and(m.organization.eq(orgId)).and(m.active.eq(true))).include("profiles.permissions.module").all()`.

**Sobrescritas.** Um endpoint próprio que substitui uma rota gerada mantém os hooks da entidade por padrão. Marque a entidade com `@overrideHooks replace` quando a sobrescrita deve rodar só os seus.

## Relacionados

- [Tags JSDoc](/pt-br/reference/tags/): tags de hook, `@hidden`, `@overrideHooks`.
- [Repositórios e consultas](/pt-br/reference/api/): `where`, `include`, `first`, `firstOrDefault`.
- [Erros](/pt-br/reference/errors/): os corpos de 401, 403 e 404.
- [Configuração](/pt-br/reference/config/): `populate.maxDepth`.

Próxima: [Upload de arquivos com uma entidade](/pt-br/recipes/uploads-with-entities/).
