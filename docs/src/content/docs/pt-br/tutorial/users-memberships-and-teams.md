---
title: Usuários, vínculos e times
description: Combine campos de duas entidades em uma relação e leia-a pelos dois lados.
sidebar:
  order: 4
---

Usuários entram em organizações por meio de vínculos (memberships), e times agrupam usuários dentro de uma organização. Aqui o modelo ganha suas três últimas entidades, e você conhece as **relações**: dois campos, um em cada entidade, que descrevem a mesma ligação e ficam sincronizados.

<details>
<summary>As entidades até aqui</summary>

```ts check title="entities/Module.ts"
export enum ModuleAction {
    manage,
    view
}

export type Module = {
    slug: string
    active: boolean
}
```

```ts check title="entities/Permission.ts"
import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}
```

```ts check title="entities/Profile.ts"
import { Permission } from "./Permission"

export type Profile = {
    slug: string
    permissions: Permission[]
}
```

</details>

## A entidade User

Crie `entities/User.ts`:

```ts check title="entities/User.ts"
import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Team } from "./Team"

export enum UserRole {
    admin,
    basic
}

export type User = {
    email: string
    name?: string
    picture?: Media

    /** @default UserRole.basic */
    role: UserRole

    memberships: Membership[]
    teams: Team[]
}
```

- `role` é obrigatório, mas `@default UserRole.basic` o preenche quando o corpo de uma criação o omite. `@default` aceita um membro do próprio enum do campo ou o valor em si (`@default 'basic'`).
- `memberships` e `teams` são arrays de referências. Como todo array de referências não opcional, eles valem `[]` quando você os omite.

## A entidade Membership

Crie `entities/Membership.ts`:

```ts check title="entities/Membership.ts"
import { Profile } from "./Profile"
import { Organization } from "./Organization"
import { User } from "./User"

export type Membership = {
    organization: Organization
    user: User
    profiles: Profile[]
    active: boolean
}
```

## A entidade Team

Crie `entities/Team.ts`:

```ts check title="entities/Team.ts"
import { Media } from "@quickservice/core"
import { Organization } from "./Organization"
import { Profile } from "./Profile"
import { User } from "./User"

export type Team = {
    organization: Organization
    name: string
    picture?: Media
    users: User[]
    profiles: Profile[]
    active: boolean
}
```

## Os membros de uma organização

Por fim, dê a `Organization` seus `members`. Este é o `entities/Organization.ts` final:

```ts check title="entities/Organization.ts"
import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Module } from "./Module"

export type Organization = {
    slug: string
    legalName: string
    name?: string
    logo?: Media;
    active: boolean
    modules: Module[]
    members: Membership[]
}
```

Sua pasta `entities/` agora é igual a `examples/identity/entities`.

## Como os campos formam relações

Quando a entidade A tem exatamente um campo apontando para a entidade B, e B tem exatamente um campo apontando de volta para A, o quickservice combina os dois campos em uma relação. O tipo depende dos dois lados:

| Campos | Tipo | Gravada como | Lado derivado |
| --- | --- | --- | --- |
| `Membership.user` e `User.memberships` | 1-N | a coluna `user` de `memberships` | `User.memberships` |
| `Membership.organization` e `Organization.members` | 1-N | a coluna `organization` de `memberships` | `Organization.members` |
| `Team.users` e `User.teams` | N-N | uma tabela de junção, `teams__users` | nenhum: os dois leem a mesma tabela |

- Uma relação **1-N** é gravada uma única vez, como a chave estrangeira do lado único. O lado do array é **derivado**: não tem coluna e é calculado na leitura, ordenado pelo `createdAt` dos registros relacionados.
- Uma relação **N-N** é gravada em uma tabela de junção, então uma mudança feita por qualquer lado aparece nos dois.

As outras referências continuam de mão única. `Team.organization` não tem par, porque `Organization` não tem campo apontando para `Team`. `Membership.profiles` e `Team.profiles` também não têm.

:::tip
Quando as duas entidades têm mais de um campo apontando para a outra, o build falha e pede que você os combine com `@inverse <campo>`. `@inverse none` deixa um campo fora de qualquer relação.
:::

## Experimente

Crie um usuário. `role` recebe seu valor padrão, e os dois arrays começam vazios:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@acme.co","name":"Ana"}'
```

```json
{
  "email": "ana@acme.co",
  "name": "Ana",
  "role": "basic",
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.851Z",
  "picture": null,
  "memberships": [],
  "teams": []
}
```

Um papel fora do enum falha:

```bash
curl -X POST localhost:3000/users -d '{"email":"x@acme.co","role":"owner"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "role", "message": "Must be one of: admin, basic" }]
  }
}
```

### Um vínculo aparece nos dois lados

O servidor de desenvolvimento reiniciou quando você adicionou as entidades, então primeiro recrie um módulo `billing`, uma permissão `manage` para ele, o perfil `finance` e a organização `acme`, como nas páginas anteriores. Depois, adicione a Ana à Acme:

```bash
curl -X POST localhost:3000/memberships \
  -d '{"organization":"<acme-id>","user":"<ana-id>","profiles":["<finance-id>"],"active":true}'
```

```json
{
  "organization": "01a1…5773",
  "user": "01a1…1ba1",
  "profiles": ["01a1…4594"],
  "active": true,
  "id": "01a1…f7cb",
  "createdAt": "2026-10-16T22:25:20.852Z",
  "updatedAt": "2026-10-16T22:25:20.852Z"
}
```

Você só gravou o vínculo, mas o usuário já o lista:

```bash
curl localhost:3000/users/<ana-id>
```

```json
{
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.851Z",
  "email": "ana@acme.co",
  "name": "Ana",
  "picture": null,
  "role": "basic",
  "memberships": ["01a1…f7cb"],
  "teams": []
}
```

E a organização também:

```bash
curl "localhost:3000/organizations/<acme-id>?fields=slug,members"
```

```json
{ "slug": "acme", "members": ["01a1…f7cb"] }
```

### Times por qualquer um dos lados

Crie um time com a Ana:

```bash
curl -X POST localhost:3000/teams \
  -d '{"organization":"<acme-id>","name":"Finance","users":["<ana-id>"],"profiles":["<finance-id>"],"active":true}'
```

```json
{
  "organization": "01a1…5773",
  "name": "Finance",
  "profiles": ["01a1…4594"],
  "active": true,
  "id": "01a1…535f",
  "createdAt": "2026-10-16T22:25:20.852Z",
  "updatedAt": "2026-10-16T22:25:20.852Z",
  "picture": null,
  "users": ["01a1…1ba1"]
}
```

```bash
curl "localhost:3000/users/<ana-id>?fields=email,teams"
```

```json
{ "email": "ana@acme.co", "teams": ["01a1…535f"] }
```

Agora tire-a do time, desta vez gravando pelo lado do usuário:

```bash
curl -X PATCH localhost:3000/users/<ana-id> -d '{"teams":{"remove":["<team-id>"]}}'
```

```json
{
  "email": "ana@acme.co",
  "name": "Ana",
  "role": "basic",
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.854Z",
  "picture": null,
  "memberships": ["01a1…f7cb"],
  "teams": []
}
```

O time vê a mudança na hora:

```bash
curl "localhost:3000/teams/<team-id>?fields=name,users"
```

```json
{ "name": "Finance", "users": [] }
```

### Populate por um lado derivado

Os lados derivados funcionam como campos gravados em `populate`, `fields` e filtros:

```bash
curl "localhost:3000/users/<ana-id>?populate=memberships.organization&fields=email,memberships.organization.slug"
```

```json
{ "email": "ana@acme.co", "memberships": [{ "organization": { "slug": "acme" } }] }
```

### Ligações obrigatórias se protegem

`Membership.user` é obrigatório, então você não pode separar um vínculo do seu usuário gravando pelo lado do usuário:

```bash
curl -X PATCH localhost:3000/users/<ana-id> -d '{"memberships":[]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "memberships", "message": "Cannot unlink: user is required" }]
  }
}
```

Pelo mesmo motivo, um usuário que ainda tem vínculos não pode ser excluído:

```bash
curl -X DELETE localhost:3000/users/<ana-id>
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by memberships"
  }
}
```

## Saiba mais

- [Tags JSDoc](/pt-br/reference/tags/): `@default`, `@inverse`, `@owner`, `@joinTable` e `@onDelete`.
- [Parâmetros de consulta HTTP](/pt-br/reference/http/): `populate`, `fields` e filtros em arrays de referências.
- [Erros](/pt-br/reference/errors/): `Cannot delete` e as outras mensagens.

## Próximo passo

Grave tudo isso em um banco de dados de verdade: [Migrations e PostgreSQL](/pt-br/tutorial/migrations-and-postgres/).
