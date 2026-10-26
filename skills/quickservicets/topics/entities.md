# Entities

How to write entity files: names, field types, JSDoc tags, references and relations.

An entity is one exported TypeScript type in its own file in `entities/`. The build turns it into a table (or MongoDB collection), CRUD routes, validation, a typed repository and API docs.

## Steps

1. Create `entities/<Name>.ts` in PascalCase, exporting one type with the same name.
2. Write fields with the supported types below; mark optional fields with `?:`.
3. Add JSDoc tags above fields and above the type.
4. Run `bun run build`, then `bun run quickservicets migration add <Name>` and `bun run quickservicets migrate` (not needed on the memory database).

```ts
// entities/Organization.ts
export type Organization = {
  /** @unique */
  slug: string;
  name: string;
  plan: "free" | "pro";
};
```

```ts
// entities/Member.ts
import type { Organization } from "./Organization";

/** @populate:read organization */
export type Member = {
  /** @unique @format email */
  email: string;
  /** @maxLength 80 */
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
  /** @onDelete cascade */
  organization: Organization;
  /** @hidden */
  passwordHash?: string;
};
```

## Names

| File | Routes | Repository | Table |
| --- | --- | --- | --- |
| `entities/Task.ts` | `/tasks` | `repos.tasks` | `tasks` |
| `entities/BlogPost.ts` | `/blog-posts` | `repos.blogPosts` | `blog_posts` |
| `entities/auth/Account.ts` | `/auth/accounts` | `repos.auth.accounts` | `accounts` in schema `auth` |

`@collection people` on the type picks another collection name. A subfolder of `entities/` is a database schema, one level deep only.

## Field types

| Type | Notes |
| --- | --- |
| `string`, `number`, `boolean` | `number` rejects `NaN` and infinite values. |
| `Date` | Sent and returned as ISO 8601 strings. |
| `"a" \| "b"`, an `enum` or a union alias | One of the values; shared enums can live in `entities/enums.ts`. |
| `T[]` | Arrays of any type above, objects included. |
| `{ width: number; unit?: string }` | Inline objects, nested to any depth. |
| Another entity, like `Organization` | A reference, stored as the record's id (top-level fields only). |
| `User[]` | A reference array, stored as ids. |
| `File`, `Media` from `@quickservicets/core` | Uploaded files, sent with multipart requests. |

A field without `?:` is required and never accepts `null`. An optional field accepts `null` to clear it.

## Common tags

- Fields: `@unique`, `@index`, `@default <value>`, `@minLength`/`@maxLength`, `@min`/`@max`, `@integer`, `@format email|url`, `@hidden`, `@minItems`/`@maxItems`.
- References: `@onDelete restrict|cascade|setNull` (arrays: `pull`), `@inverse <field>`.
- Entities: `@collection`, `@schema`, `@internal` (no routes), `@fields`, `@populate`.
- Any other tag on an entity names a hook from `hooks/`, like `@authorized` for `hooks/authorized.ts` (see the `endpoints-and-hooks` topic).
- Native features add tags such as `@rateLimit`, `@history`, `@etag` and `@publish` (see the `features` topic).

## The generated API

```bash
curl -X POST localhost:3000/members -H "content-type: application/json" -d '{"email":"ana@acme.com","organization":"<organization id>"}'
curl -g "localhost:3000/members?where[role][eq]=admin&sort=-createdAt&limit=10&populate=organization"
curl -X PATCH localhost:3000/members/<id> -H "content-type: application/json" -d '{"name":"Ana"}'
```

Lists answer `{ data, total, limit, offset }`. Errors answer `{ "error": { "code", "message", "details"? } }`, like `400 VALIDATION_ERROR` with one detail per field or `409 CONFLICT` for a `@unique` value that exists.

Full docs: [Entities and tags](/guides/entities/); every tag is in [JSDoc tags](/reference/tags/).

## Do not

- Do not declare `id`, `createdAt` or `updatedAt`.
- Do not write `field: string | null`; write `field?: string`.
- Do not use `bigint`, `any` or types declared outside `entities/` as field types.
- Do not put two entities in one file or name the file differently from the type.
- Do not nest folders in `entities/` more than one level.
- Do not reference an entity inside a nested object; references are top-level fields only.
- Do not forget `bun run build` and a migration after changing an entity.
