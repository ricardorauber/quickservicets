---
title: Permission checks
description: A reusable authorized hook that checks a role or a permission, and an endpoint that answers "can this user do that?".
sidebar:
  order: 10
---

**The problem:** some routes are for admins only, others for anyone granted a permission such as `billing:manage`, and a front end wants to ask whether a user may do something before showing a button. You want one check, written once, that every entity and endpoint can reuse with a tag.

**The solution:** a pre-hook named `authorized` that reads the bearer token, loads the user and checks the role or permission written in the tag, plus a small helper that collects a user's permissions with a [fluent query](/reference/api/#query) and `include`.

## The model

Permissions belong to modules (`billing`, `reports`), profiles group permissions, and users hold profiles. `manage` also grants `view`, and an inactive module grants nothing.

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

The entity the permissions protect: anyone can read invoices, but writing them needs `billing:manage`.

```ts check title="entities/Invoice.ts"
/** @authorized:create,update,replace,delete billing:manage */
export type Invoice = {
  /** @unique */
  number: string;
  /** @min 0 */
  total: number;
};
```

The path `profiles.permissions.module` has three segments, one more than the default [`populate.maxDepth`](/reference/config/):

```ts check title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  // "profiles.permissions.module" has three segments.
  populate: { maxDepth: 3 },
});
```

<details>
<summary>The generated types these snippets rely on (excerpt of <code>.generated/types.ts</code>)</summary>

The build writes this file for you; it is shown here so the snippets on this page type-check on their own.

```ts check title=".generated/types.ts"
import type { Many, One, Repository } from "@quickservicets/core";

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

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

## The permissions helper

One function answers "what may this user do?", so the hook and the endpoint below agree. It loads the user with every profile, permission and module in one query, and fails with 404 `User not found` when the id does not exist.

```ts check title="lib/permissions.ts"
import type { Repositories } from "@quickservicets/core";

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

## The hook

The tag's arguments say what the route needs:

- `@authorized`: any signed-in user.
- `@authorized admin`: users with that role.
- `@authorized billing:manage`: users granted that permission.
- Several arguments (`@authorized billing:manage,reports:view`): one match is enough.

Admins pass every check. The hook keeps the user in `req.context.user`, so later hooks and the handler can use it.

```ts check title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservicets/core";
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

`docs` adds the 401 and 403 responses and the bearer security scheme to every operation that uses the hook, so the [API docs](/reference/errors/) show the lock and the error bodies.

## The permission-check endpoint

`GET /users/:userId/has-permissions?p=billing:manage&p=reports:view` answers whether a user holds the permissions, and which are missing. Its [typed query items](/reference/http/) are converted and validated before the handler runs; only admins may ask.

```ts check title="endpoints/users/[userId]/has-permissions/get.ts"
import type { Endpoint } from "@quickservicets/core";
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

## The first admin

Every route that manages access is now admin-only, so create the first admin outside the API, for example in a migration that reads the token from the environment:

```ts check title="migrations/20261016120000_SeedAdmin.ts"
import type { MigrationContext } from "@quickservicets/core";
import { hashToken } from "../lib/permissions.ts";

export async function up(ctx: MigrationContext): Promise<void> {
  await ctx.repos.users.create({ email: "ana@acme.co", tokenHash: hashToken(process.env.ADMIN_TOKEN!), role: "admin" });
}

export async function down(ctx: MigrationContext): Promise<void> {
  const admin = await ctx.repos.users.where((u) => u.email.eq("ana@acme.co")).firstOrDefault();
  if (admin) await ctx.repos.users.delete(admin.id);
}
```

## Try it

The requests below use Ana, the admin (token `ana-secret`), and Bruno, a member (token `bruno-secret`) whose `finance` profile grants `billing:manage`. Ana created the `billing` module, its `manage` permission and the `finance` profile with the generated routes, and then Bruno, sending the SHA-256 of his token (`echo -n bruno-secret | shasum -a 256`):

```bash
curl -i -X POST localhost:3000/users -H "Authorization: Bearer ana-secret" \
  -d '{"email":"bruno@acme.co","tokenHash":"ca0a9db2204c4c84cb6ba3d96a7bdaf319eb89afa52e5b43c0f19b19097b6e1d","profiles":["01a146d9-b62f-7493-839f-f1dc2e8a759b"]}'
```

```txt
HTTP/1.1 201 Created

{"email":"bruno@acme.co","profiles":["01a146d9-b62f-7493-839f-f1dc2e8a759b"],"role":"member","id":"01a146d9-b630-73b2-ad4b-ac46a31ca6a5","createdAt":"2026-10-16T22:33:55.504Z","updatedAt":"2026-10-16T22:33:55.504Z"}
```

`tokenHash` is `@hidden`, so it never comes back.

Without a token, the hook stops the request before the handler:

```bash
curl -i -X POST localhost:3000/invoices -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 401 Unauthorized

{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

A token that matches no user is also a 401:

```bash
curl -i -X POST localhost:3000/invoices -H "Authorization: Bearer nope" -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 401 Unauthorized

{"error":{"code":"UNAUTHORIZED","message":"Invalid token"}}
```

Bruno holds `billing:manage`, so he can create invoices:

```bash
curl -i -X POST localhost:3000/invoices -H "Authorization: Bearer bruno-secret" \
  -d '{"number":"2026-001","total":120}'
```

```txt
HTTP/1.1 201 Created

{"number":"2026-001","total":120,"id":"01a146d9-b631-700b-81dc-90cdcd2b1cdd","createdAt":"2026-10-16T22:33:55.505Z","updatedAt":"2026-10-16T22:33:55.505Z"}
```

Reading is not tagged, so it needs no token:

```bash
curl localhost:3000/invoices
```

```json
{"data":[{"id":"01a146d9-b631-700b-81dc-90cdcd2b1cdd","createdAt":"2026-10-16T22:33:55.505Z","updatedAt":"2026-10-16T22:33:55.505Z","number":"2026-001","total":120}],"total":1,"limit":20,"offset":0}
```

But managing users is for admins only:

```bash
curl -i -X POST localhost:3000/users -H "Authorization: Bearer bruno-secret" \
  -d '{"email":"carla@acme.co","tokenHash":"..."}'
```

```txt
HTTP/1.1 403 Forbidden

{"error":{"code":"FORBIDDEN","message":"Not allowed"}}
```

Ana asks what Bruno may do. `manage` grants `view` too, and nothing grants `reports:view`:

```bash
curl "localhost:3000/users/01a146d9-b630-73b2-ad4b-ac46a31ca6a5/has-permissions?p=billing:view&p=reports:view" \
  -H "Authorization: Bearer ana-secret"
```

```json
{"allowed":false,"missing":["reports:view"]}
```

With `rule=any`, one granted permission is enough:

```bash
curl "localhost:3000/users/01a146d9-b630-73b2-ad4b-ac46a31ca6a5/has-permissions?p=billing:view&p=reports:view&rule=any" \
  -H "Authorization: Bearer ana-secret"
```

```json
{"allowed":true,"missing":["reports:view"]}
```

The query items are checked before the handler runs, and an unknown user is a 404:

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

In `/openapi.json`, every operation that runs the hook lists it, with its errors and the security scheme:

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

`components.securitySchemes.bearerAuth` is `{ "type": "http", "scheme": "bearer" }`, so the docs page at `/docs` lets you paste a token once and send it with every request.

## Variations

**Read the current user in a handler.** The hook stored the user in `req.context`, so a `GET /me` endpoint is a few lines:

```ts check title="endpoints/me/get.ts"
import type { Endpoint } from "@quickservicets/core";
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

**Only some operations.** Scope the tag with operations, as `Invoice` does: `@authorized:create,update,replace,delete billing:manage`. One hook can appear only once per entity, so put the stricter rule on the operations that need it.

**Permissions per organization.** When permissions depend on an organization, as in a multi-tenant app, add an `organization` query item and look for the user's active memberships in it: `repos.memberships.where((m) => m.user.eq(userId).and(m.organization.eq(orgId)).and(m.active.eq(true))).include("profiles.permissions.module").all()`.

**Overrides.** A custom endpoint that replaces a generated route keeps the entity's hooks by default. Tag the entity `@overrideHooks replace` when the override should run only its own.

## Related

- [JSDoc tags](/reference/tags/): hook tags, `@hidden`, `@overrideHooks`.
- [Repositories and queries](/reference/api/): `where`, `include`, `first`, `firstOrDefault`.
- [Errors](/reference/errors/): the 401, 403 and 404 bodies.
- [Configuration](/reference/config/): `populate.maxDepth`.

Next: [Uploading files with an entity](/recipes/uploads-with-entities/).
