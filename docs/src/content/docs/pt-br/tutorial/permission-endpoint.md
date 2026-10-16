---
title: O endpoint de verificação de permissões
description: Adicione um endpoint customizado com query items tipados e consultas fluentes nos repositórios.
sidebar:
  order: 6
---

O modelo está pronto e roda no PostgreSQL ([página anterior](/pt-br/tutorial/migrations-and-postgres/)). Cada entidade já tem suas rotas CRUD. Agora vamos adicionar a única rota que o gerador não escreve por você: uma verificação que responde "este usuário tem estas permissões nesta organização?", servida em `GET /users/:userId/has-permissions`.

A resposta é `true` ou `false`, seguindo estas regras:

- As permissões vêm da **membership** do usuário na organização e dos **times** dessa organização dos quais o usuário faz parte. Os dois têm perfis, e os perfis têm permissões.
- Uma permissão é um módulo mais uma ação. `manage` também concede `view`.
- Organizações, módulos, memberships e times inativos não concedem nada.
- `rule=all` exige todas as permissões de `p`; `rule=any` exige uma.

## Onde o endpoint fica

Endpoints customizados ficam em `endpoints/`, com caminhos no estilo do Next.js. Um segmento entre colchetes é um parâmetro de caminho, e o nome do arquivo é o método HTTP. Então este arquivo serve `GET /users/:userId/has-permissions`:

```text
endpoints/
  users/
    [userId]/
      has-permissions/
        get.ts
```

O arquivo exporta por padrão um handler. Ele recebe os repositórios (`repos`), a requisição (`req`) e os controles da resposta (`res`), e retorna o corpo da resposta.

## O endpoint

Este é o arquivo inteiro, como está em `examples/identity`:

```ts check title="endpoints/users/[userId]/has-permissions/get.ts"
import { type Endpoint } from "@quickservice/core";

type Query = {
    /** Permissions as `<module slug>:<action>`, e.g. `billing:manage`; repeat the key for each one. */
    p: string[]
    /** `all`: every permission is required; `any`: one is enough. */
    rule: "all" | "any"
    /** The organization the permissions apply to. */
    organization: string
}

/**
 * @summary Check a user's permissions
 * @description Grants come from the user's active membership in the organization and from its active teams the user belongs to; `manage` also grants `view`.
 */
const handler: Endpoint<Query, boolean> = async (repos, req) => {
    const { p, rule, organization } = req.queryItems
    const userId = req.params.userId!

    const org = await repos.organizations.where((o) => o.id.eq(organization).and(o.active.eq(true))).firstOrDefault()
    if (!org) return false

    const memberships = await repos.memberships
        .where((m) => m.user.eq(userId).and(m.organization.eq(organization)).and(m.active.eq(true)))
        .include("profiles.permissions.module")
        .all()
    const teams = await repos.teams
        .where((t) => t.users.contains(userId).and(t.organization.eq(organization)).and(t.active.eq(true)))
        .include("profiles.permissions.module")
        .all()

    const granted = new Set(
        [...memberships, ...teams]
            .flatMap((source) => source.profiles)
            .flatMap((profile) => profile.permissions)
            .filter(({ module }) => module?.active)
            .flatMap(({ module, action }) => action === "manage" ? [`${module!.slug}:manage`, `${module!.slug}:view`] : [`${module!.slug}:view`]),
    )
    return rule === "all" ? p.every((permission) => granted.has(permission)) : p.some((permission) => granted.has(permission))
}

export default handler
```

O resto desta página explica cada parte.

## Query items tipados

`Endpoint<Query, boolean>` recebe dois argumentos de tipo. Num endpoint GET ou DELETE, o primeiro é o **tipo da query**: cada propriedade é um query item. O segundo é o tipo do resultado.

O framework lê `Query` no build. A cada requisição, ele converte e valida a query string e entrega ao handler um objeto tipado em `req.queryItems`:

- `p: string[]` é um array, lido de chaves repetidas: `?p=billing:manage&p=reports:view` vira `["billing:manage", "reports:view"]`.
- `rule: "all" | "any"` precisa ser um dos seus valores.
- `organization: string` é uma única string.
- Nenhum deles é opcional, então todos são obrigatórios.

Query items podem ser strings, números, booleanos, `Date`s, uniões de strings, enums de string nomeados e arrays desses tipos. Marque um item como opcional com `?`. Chaves que você não declara são ignoradas; a query string bruta continua em `req.query` (um `URLSearchParams`).

:::tip
Query items também aceitam as tags `@default`, `@min`, `@max`, `@minLength` e `@maxLength`, por exemplo `/** @default 20 @min 1 @max 100 */ limit?: number`.
:::

O handler nunca roda com uma query inválida. Quando um item falta ou é inválido, o endpoint responde 400 com todos os problemas em `details`:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"p","message":"Is required"},{"field":"rule","message":"Is required"},{"field":"organization","message":"Is required"}]}}
```

Um valor fora da união:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=some&p=billing:view"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"rule","message":"Must be one of: all, any"}]}}
```

Uma chave repetida num item que não é array:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&organization=x&rule=all&p=billing:view"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"organization","message":"Parameter is repeated"}]}}
```

O parâmetro de caminho vem de `req.params.userId`. Ele é sempre uma string, e o `!` diz ao TypeScript que ele existe (a rota não casa sem ele).

## Consultas fluentes

Os repositórios têm uma API de consulta fluente e tipada. `where(...)` recebe uma lambda com um handle por campo e retorna uma consulta:

```ts check
import type { Repositories } from "@quickservice/core";
declare const repos: Repositories;
declare const organization: string;

const org = await repos.organizations.where((o) => o.id.eq(organization).and(o.active.eq(true))).firstOrDefault()
```

- Cada handle oferece os operadores do tipo do seu campo: `eq`, `ne`, `in`, `gt` e assim por diante. O TypeScript confere os nomes dos campos e os tipos dos valores.
- `.and(...)` combina condições (também existe `.or(...)`).
- `firstOrDefault()` retorna o primeiro resultado ou `null`. Aqui, `null` quer dizer que a organização não existe ou está inativa, então a resposta é `false`.

A consulta de memberships usa as mesmas peças, mais `include`:

```ts check
import type { Repositories } from "@quickservice/core";
declare const repos: Repositories;
declare const organization: string, userId: string;

const memberships = await repos.memberships
    .where((m) => m.user.eq(userId).and(m.organization.eq(organization)).and(m.active.eq(true)))
    .include("profiles.permissions.module")
    .all()
```

- `m.user` e `m.organization` são referências, então `eq` compara ids.
- `.include("profiles.permissions.module")` troca cada id do caminho pelo seu registro: os perfis da membership, as permissões deles e o módulo de cada permissão. O resultado é tipado em todos os níveis, então `membership.profiles[0].permissions[0].module.slug` passa na checagem de tipos.
- `.all()` retorna todos os resultados.

A consulta de times é igual, com `t.users.contains(userId)`: `users` é um array de referências, e `contains` encontra os times que guardam o id do usuário.

:::note
`include` segue o mesmo limite de profundidade que `populate`: `populate.maxDepth`, 2 por padrão. `profiles.permissions.module` tem três segmentos, por isso o exemplo define `populate: { maxDepth: 3 }` em `quickservice.config.ts`.
:::

O TypeScript rejeita caminhos que não existem. Este tem um erro de digitação, então não compila:

```ts
// Erro: Argument of type '"profiles.permisions"' is not assignable to parameter of type ...
repos.memberships.where((m) => m.user.eq(userId)).include("profiles.permisions")
```

## Calculando as permissões

A última parte é TypeScript puro:

1. Junte os perfis da membership e dos times, e depois as permissões deles.
2. Descarte as permissões cujo módulo está inativo (`module?.active`). Uma referência incluída pode ser `null`, daí o `?.`.
3. Transforme cada permissão em strings como `billing:view`. `manage` adiciona `billing:manage` e `billing:view`.
4. Compare com `p`: `every` para `all`, `some` para `any`.

As ações das permissões são os valores do enum `ModuleAction`, `"manage"` e `"view"`. No código, compare com as strings, já que o enum não tem inicializadores.

## Teste

Digamos que a membership da Ana na Acme tem um perfil com `billing:manage`, e o time "Data" dela tem um perfil com `reports:view`. Inicie o servidor com `bun run dev` e pergunte:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:view"
```

```json
true
```

`billing:view` vem de `billing:manage`. As duas origens juntas:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:manage&p=reports:view"
```

```json
true
```

Ninguém concedeu `reports:manage`:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=reports:manage"
```

```json
false
```

Com `rule=any`, um acerto basta:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=any&p=reports:manage&p=reports:view"
```

```json
true
```

## De onde vêm os tipos de `repos`

`repos.organizations`, `repos.memberships` e `repos.teams` são tipados porque o build escreve `.generated/types.ts`. Ele declara um tipo por entidade, um mapa `<Entidade>References` com as referências dela, e adiciona um repositório tipado por entidade a `Repositories`. Uma versão reduzida desse arquivo, com o que este endpoint usa:

```ts check title=".generated/types.ts"
// Reduzido: o arquivo gerado também tem os tipos de entrada Create e Update e todos os repositórios.
import type { Many, One, Repository } from "@quickservice/core";

export type Membership = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organization: string;
  user: string;
  profiles: Array<string>;
  active: boolean;
};

export type MembershipReferences = {
  organization: One<Organization, OrganizationReferences>;
  user: One<User, UserReferences>;
  profiles: Many<Profile, ProfileReferences>;
};

export type Module = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  active: boolean;
};

export type ModuleReferences = Record<never, never>;

export type Organization = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  legalName: string;
  name?: string | null;
  logo?: string | null;
  active: boolean;
  modules: Array<string>;
  members: Array<string>;
};

export type OrganizationReferences = {
  logo: One<Media, MediaReferences>;
  modules: Many<Module, ModuleReferences>;
  members: Many<Membership, MembershipReferences>;
};

export type Permission = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  module: string;
  action: "manage" | "view";
};

export type PermissionReferences = {
  module: One<Module, ModuleReferences>;
};

export type Profile = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  permissions: Array<string>;
};

export type ProfileReferences = {
  permissions: Many<Permission, PermissionReferences>;
};

export type Team = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organization: string;
  name: string;
  picture?: string | null;
  users: Array<string>;
  profiles: Array<string>;
  active: boolean;
};

export type TeamReferences = {
  organization: One<Organization, OrganizationReferences>;
  picture: One<Media, MediaReferences>;
  users: Many<User, UserReferences>;
  profiles: Many<Profile, ProfileReferences>;
};

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name?: string | null;
  picture?: string | null;
  role: "admin" | "basic";
  memberships: Array<string>;
  teams: Array<string>;
};

export type UserReferences = {
  picture: One<Media, MediaReferences>;
  memberships: Many<Membership, MembershipReferences>;
  teams: Many<Team, TeamReferences>;
};

export type Media = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  filename: string;
  mimeType: string;
  size: number;
  storage: string;
  storageKey?: string | null;
  url: string;
};

export type MediaReferences = Record<never, never>;

export interface GeneratedRepositories {
  memberships: Repository<Membership, MembershipReferences>;
  organizations: Repository<Organization, OrganizationReferences>;
  teams: Repository<Team, TeamReferences>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

Os registros guardam as referências como ids. Os mapas `References` dizem ao `include` para onde cada id aponta, e é assim que os registros incluídos ganham seus tipos.

## Referência

- [Repositórios e consultas](/pt-br/reference/api/): todos os métodos dos repositórios e das consultas.
- [Erros](/pt-br/reference/errors/): o erro `Invalid query` e suas mensagens.
- [Tags JSDoc](/pt-br/reference/tags/#tags-de-endpoint): `@summary`, `@description` e as outras tags de endpoint.
- [Configuração](/pt-br/reference/config/): `populate.maxDepth` e `repositories.findAllMax`.

## Próximo passo

O endpoint já aparece na documentação da API, com seus query items. Veja em [Documentação da API em /docs](/pt-br/tutorial/api-docs/).
