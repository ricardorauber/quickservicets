---
title: The permission check endpoint
description: Add a custom endpoint with typed query items and fluent repository queries.
sidebar:
  order: 6
---

The model is done, and it runs on PostgreSQL ([previous page](/tutorial/migrations-and-postgres/)). Every entity already has its CRUD routes. Now add the one route the generator can't write for you: a check that answers "does this user have these permissions in this organization?", served at `GET /users/:userId/has-permissions`.

The answer is `true` or `false`. It follows these rules:

- Grants come from the user's **membership** in the organization and from the **teams** of that organization the user belongs to. Both carry profiles, and profiles carry permissions.
- A permission is a module plus an action. `manage` also grants `view`.
- Inactive organizations, modules, memberships and teams grant nothing.
- `rule=all` needs every permission in `p`; `rule=any` needs one.

## Where the endpoint lives

Custom endpoints live in `endpoints/`, with Next.js-style paths. A segment in brackets is a path parameter, and the file name is the HTTP method. So this file serves `GET /users/:userId/has-permissions`:

```text
endpoints/
  users/
    [userId]/
      has-permissions/
        get.ts
```

The file default-exports a handler. It receives the repositories (`repos`), the request (`req`) and the response controls (`res`), and returns the response body.

## The endpoint

Here is the whole file, as it is in `examples/identity`:

```ts check title="endpoints/users/[userId]/has-permissions/get.ts"
import { type Endpoint } from "@quickservicets/core";

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
        .toArray()
    const teams = await repos.teams
        .where((t) => t.users.contains(userId).and(t.organization.eq(organization)).and(t.active.eq(true)))
        .include("profiles.permissions.module")
        .toArray()

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

The rest of this page walks through it.

## Typed query items

`Endpoint<Query, boolean>` takes two type arguments. On a GET or DELETE endpoint, the first one is the **query type**: each property is a query item. The second is the result type.

The framework reads `Query` at build time. On each request it converts and validates the query string, then hands the handler a typed object in `req.queryItems`:

- `p: string[]` is an array, read from repeated keys: `?p=billing:manage&p=reports:view` gives `["billing:manage", "reports:view"]`.
- `rule: "all" | "any"` must be one of its values.
- `organization: string` is a single string.
- None of them is optional, so each one is required.

Query items can be strings, numbers, booleans, `Date`s, string unions, named string enums, and arrays of these. Mark an item optional with `?`. Keys you don't declare are ignored; the raw query string is still in `req.query` (a `URLSearchParams`).

:::tip
Query items also take `@default`, `@min`, `@max`, `@minLength` and `@maxLength` tags, for example `/** @default 20 @min 1 @max 100 */ limit?: number`.
:::

The handler never runs with a bad query. When an item is missing or invalid, the endpoint answers 400 with every problem in `details`:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"p","message":"Is required"},{"field":"rule","message":"Is required"},{"field":"organization","message":"Is required"}]}}
```

A value outside the union:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=some&p=billing:view"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"rule","message":"Must be one of: all, any"}]}}
```

A repeated key on an item that is not an array:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&organization=x&rule=all&p=billing:view"
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"organization","message":"Parameter is repeated"}]}}
```

The path parameter comes from `req.params.userId`. It is always a string, and the `!` tells TypeScript it is there (the route can't match without it).

## Fluent queries

Repositories have a fluent, typed query API. `where(...)` takes a lambda that receives one handle per field, and returns a query:

```ts check
import type { Repositories } from "@quickservicets/core";
declare const repos: Repositories;
declare const organization: string;

const org = await repos.organizations.where((o) => o.id.eq(organization).and(o.active.eq(true))).firstOrDefault()
```

- Each handle offers the operators of its field type: `eq`, `ne`, `in`, `gt` and so on. TypeScript checks field names and value types.
- `.and(...)` combines conditions (`.or(...)` also exists).
- `firstOrDefault()` returns the first match or `null`. Here, `null` means the organization doesn't exist or is inactive, so the answer is `false`.

The memberships query uses the same pieces, plus `include`:

```ts check
import type { Repositories } from "@quickservicets/core";
declare const repos: Repositories;
declare const organization: string, userId: string;

const memberships = await repos.memberships
    .where((m) => m.user.eq(userId).and(m.organization.eq(organization)).and(m.active.eq(true)))
    .include("profiles.permissions.module")
    .toArray()
```

- `m.user` and `m.organization` are references, so `eq` compares ids.
- `.include("profiles.permissions.module")` replaces each id along the path with its record: the membership's profiles, their permissions and each permission's module. The result is typed at every level, so `membership.profiles[0].permissions[0].module.slug` type-checks.
- `.toArray()` returns every match.

The teams query is the same, with `t.users.contains(userId)`: `users` is a reference array, and `contains` matches teams that hold the user's id.

:::note
`include` follows the same depth limit as `populate`: `populate.maxDepth`, 2 by default. `profiles.permissions.module` has three segments, so the example sets `populate: { maxDepth: 3 }` in `quickservicets.config.ts`.
:::

TypeScript rejects paths that don't exist. This one has a typo, so it fails to compile:

```ts
// Argument of type '"profiles.permisions"' is not assignable to parameter of type ...
repos.memberships.where((m) => m.user.eq(userId)).include("profiles.permisions")
```

## Computing the grants

The last part is plain TypeScript:

1. Collect the profiles of the membership and the teams, then their permissions.
2. Drop permissions whose module is inactive (`module?.active`). An included reference can be `null`, hence the `?.`.
3. Turn each permission into strings like `billing:view`. `manage` adds both `billing:manage` and `billing:view`.
4. Compare with `p`: `every` for `all`, `some` for `any`.

Permission actions are the values of the `ModuleAction` enum, `"manage"` and `"view"`. In code, compare with the strings, as the enum has no initializers.

:::note
In `examples/identity`, steps 1 to 3 live in `lib/permissions.ts` as `grantedPermissions(repos, userId, organizationId)`, and the endpoint only does step 4. A `@requires` hook reuses the same function to protect the organization stats endpoint; the example's `README.md` describes both.
:::

## Try it

Say Ana's membership in Acme has a profile with `billing:manage`, and her "Data" team has a profile with `reports:view`. Start the server with `bun run dev` and ask:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:view"
```

```json
true
```

`billing:view` comes from `billing:manage`. Both sources together:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:manage&p=reports:view"
```

```json
true
```

Nobody granted `reports:manage`:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=all&p=reports:manage"
```

```json
false
```

With `rule=any`, one match is enough:

```bash
curl "localhost:3000/users/<ana-id>/has-permissions?organization=<acme-id>&rule=any&p=reports:manage&p=reports:view"
```

```json
true
```

## Where the types of `repos` come from

`repos.organizations`, `repos.memberships` and `repos.teams` are typed because the build writes `.generated/types.ts`. It declares one type per entity, a `<Entity>References` map for its references, and adds a typed repository per entity to `Repositories`. A trimmed version of that file, with what this endpoint uses:

```ts check title=".generated/types.ts"
// Trimmed: the generated file also has the Create and Update input types and every repository.
import type { Many, One, Repository } from "@quickservicets/core";

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

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

Records hold references as ids. The `References` maps tell `include` what each id points to, which is how the included records get their types.

## Reference

- [Repositories and queries](/reference/api/): every repository and query method.
- [Errors](/reference/errors/): the `Invalid query` error and its messages.
- [JSDoc tags](/reference/tags/#endpoint-tags): `@summary`, `@description` and the other endpoint tags.
- [Configuration](/reference/config/): `populate.maxDepth` and `repositories.toArrayMax`.

## Next

The endpoint already shows up in the API docs, with its query items. See it in [API docs at /docs](/tutorial/api-docs/).
