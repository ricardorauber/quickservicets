---
title: Entities and tags
description: Model your data as TypeScript types in entities/ and configure it with JSDoc tags.
sidebar:
  order: 10
---

An entity is a TypeScript type in the `entities/` folder. From each one, QuickService.ts generates a database table (or collection), CRUD routes, body validation, a typed repository, migrations and API docs. JSDoc tags on the type and on its fields fine-tune all of that.

## Entity files

Each entity lives in its own file, named after the type:

```ts check title="entities/Category.ts"
/** @collection product-categories */
export type Category = {
  name: string;
};
```

```ts check title="entities/Product.ts"
import type { Category } from "./Category";

export type Product = {
  name: string;
  price: number;
  inStock: boolean;
  releasedAt?: Date;
  size: "small" | "medium" | "large";
  tags: string[];
  dimensions: { width: number; height: number; unit?: string };
  category?: Category;
};
```

The rules are few:

- The file name is PascalCase (`Product.ts`, `BlogPost.ts`), and the file exports exactly one type with the same name.
- The type is an object type: `export type Product = { ... }` or `export interface Product { ... }` give the same entity.
- A folder inside `entities/` is a [database schema](#schema): `entities/auth/Account.ts` belongs to the `auth` schema. Folders go only one level deep.
- A file that exports only enums or string unions, such as `entities/enums.ts`, is not an entity. It holds types shared by entities, and its name does not need to be PascalCase. See [Enums and union aliases](/guides/enums/).

The entity name gives every other name. The collection is the kebab-case plural of the type name, and it names the routes and the repository:

| File | Routes | Repository | Table |
| --- | --- | --- | --- |
| `entities/Product.ts` | `/products` | `repos.products` | `products` |
| `entities/BlogPost.ts` | `/blog-posts` | `repos.blogPosts` | `blog_posts` |
| `entities/Box.ts` | `/boxes` | `repos.boxes` | `boxes` |
| `entities/auth/Account.ts` | `/auth/accounts` | `repos.auth.accounts` | `accounts` in schema `auth` |

When a file breaks a rule, the build stops and names it:

```text
entities/post.ts: entity file names must be PascalCase (e.g. User.ts)
entities/Post.ts: exported type Article must be named Post
entities/a/b: entities may only be nested one folder deep
```

## Field types

| TypeScript type | In JSON | Notes |
| --- | --- | --- |
| `string` | string | |
| `number` | number | `NaN` and infinite values are rejected. |
| `boolean` | `true` or `false` | |
| `Date` | ISO 8601 string | Sent as `"2026-03-01"` or `"2026-03-01T10:00:00Z"`, returned as `"2026-03-01T00:00:00.000Z"`. |
| `"small" \| "medium"`, an `enum` or a union alias | one of the values | See [Enums and union aliases](/guides/enums/). |
| `T[]` or `Array<T>` | array | Items of any type above, including objects. |
| `{ width: number; ... }` | object | Inline object types nest to any depth, with their own optional properties. |
| Another entity, like `Category` | the record's id | A [reference](/guides/references/); only on top-level fields. |
| An array of an entity, like `User[]` | array of ids | A [reference array](/guides/references/), stored as `[]` when left out. |
| `File` or `Media` from `@quickservicets/core` | the file's id | References to the built-in file entities, uploaded with multipart requests. |

Anything else stops the build with the file, field and type: `bigint`, `any`, `string | null`, types declared outside `entities/` (except shared enums and union aliases), and references inside nested objects.

```text
entities/Post.ts: field "n" has unsupported type "bigint"
entities/Post.ts: field "n" must be a union of string literals only, found "string"
```

### Optional fields

A field marked with `?:` is optional. A body may leave it out or send `null` to clear it, and responses return `null` when it has no value. A field without `?:` is required and never accepts `null`. The exact rules per request are in [Validation and error messages](/guides/validation/).

To allow `null`, make the field optional: `nickname?: string`, not `nickname: string | null`.

## System fields

Every entity gets three fields you never declare:

- `id`: a UUID v7 string, generated on create. UUID v7 starts with a timestamp, so ids sort in creation order.
- `createdAt`: when the record was created.
- `updatedAt`: when it was last changed.

They are read-only in request bodies, and you can filter and sort by them; lists sort by `-createdAt` by default. Declaring one of them in an entity stops the build:

```text
entities/Post.ts: field "id" is a system field added to every entity and cannot be declared
```

With the two entities above, creating a category and a product looks like this:

```bash
curl -X POST localhost:3000/product-categories -d '{"name":"Shoes"}'
```

```json
{
  "name": "Shoes",
  "id": "01a146d1-20bc-7420-95d8-3005f5e564c0",
  "createdAt": "2026-10-16T22:24:32.956Z",
  "updatedAt": "2026-10-16T22:24:32.956Z"
}
```

```bash
curl -X POST localhost:3000/products -d '{
  "name": "Trail runner", "price": 129.9, "inStock": true, "releasedAt": "2026-03-01",
  "size": "medium", "tags": ["outdoor", "running"], "dimensions": { "width": 11, "height": 30 },
  "category": "01a146d1-20bc-7420-95d8-3005f5e564c0"
}'
```

```json
{
  "name": "Trail runner",
  "price": 129.9,
  "inStock": true,
  "releasedAt": "2026-03-01T00:00:00.000Z",
  "size": "medium",
  "tags": ["outdoor", "running"],
  "dimensions": { "width": 11, "height": 30 },
  "category": "01a146d1-20bc-7420-95d8-3005f5e564c0",
  "id": "01a146d1-20bd-716f-88a7-ce8572d4c814",
  "createdAt": "2026-10-16T22:24:32.957Z",
  "updatedAt": "2026-10-16T22:24:32.957Z"
}
```

## Entity tags

Entity tags go in the JSDoc comment right above the type. Every tag is described in the [JSDoc tags reference](/reference/tags/).

### `@collection`

[`@collection`](/reference/tags/#collection) replaces the derived collection name, which names the routes, the repository and the table. It must match `^[a-z][a-z0-9-]*$`. The `Category` entity above uses it, so its routes are `/product-categories` and its repository is `repos.productCategories`.

```ts check title="entities/Person.ts"
/** @collection people */
export type Person = {
  name: string;
};
```

### `@schema`

Entities can live in named database schemas: PostgreSQL schemas, `<schema>__<table>` tables on SQLite and separate databases on MongoDB. Put the file in a folder, or use [`@schema`](/reference/tags/#schema), which wins over the folder:

```ts check title="entities/auth/Account.ts"
export type Account = {
  email: string;
};
```

```ts check title="entities/auth/Invoice.ts"
/** @schema billing */
export type Invoice = {
  total: number;
};
```

`Account` is in the `auth` schema and `Invoice` in `billing`. The schema prefixes the routes and nests the repository:

```bash
curl -X POST localhost:3000/auth/accounts -d '{"email":"ana@example.com"}'
```

```json
{
  "email": "ana@example.com",
  "id": "01a146d1-20bd-7171-a561-7d67f8300d9c",
  "createdAt": "2026-10-16T22:24:32.957Z",
  "updatedAt": "2026-10-16T22:24:32.957Z"
}
```

In code, that repository is `repos.auth.accounts`. Two entities may share a name in different schemas, such as `entities/User.ts` and `entities/auth/User.ts`; the generated type of the second is then `AuthUser`. Entities without a schema use the default one, which the `schema` config key or the `DATABASE_SCHEMA` environment variable can set per deployment (see the [configuration reference](/reference/config/)).

### `@internal`

[`@internal`](/reference/tags/#internal) keeps the table and the repository but creates no routes, for data you only use from code (hooks and custom endpoints):

```ts check title="entities/AuditLog.ts"
/** @internal */
export type AuditLog = {
  action: string;
};
```

```bash
curl localhost:3000/audit-logs
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

### Other entity tags

These are covered in their own guides:

| Tag | What it does |
| --- | --- |
| [`@fields`](/reference/tags/#fields) | Fields the list and read routes return. See [Field selection and hidden fields](/guides/field-selection/). |
| [`@populate`](/reference/tags/#populate) | References populated by default on list and read. |
| [`@overrideHooks`](/reference/tags/#overridehooks) | Whether custom endpoints that replace a generated route keep the entity's hooks. |
| [`@storage`](/reference/tags/#storage) | Storage of a file entity's objects. |
| [`@maxSize`](/reference/tags/#maxsize) | Largest upload a file entity accepts. |
| [`@accept`](/reference/tags/#accept) | MIME types a file entity accepts. |
| [`@access`](/reference/tags/#access) | How file URLs work: `direct`, `proxy` or `signed`. |

Any other entity tag names a hook from `hooks/`, optionally scoped to operations and with arguments: `/** @authorized:create,delete admin */` runs `hooks/authorized.ts` on create and delete with the argument `admin`.

## Field tags

Field tags go in a JSDoc comment above the field, and one comment can hold several:

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @minLength 2 @maxLength 80 */
  name: string;
  /** @min 0 @max 150 */
  age?: number;
  /** @default 'member' @index */
  role: "member" | "admin";
  /** @default [] @maxItems 10 */
  tags: string[];
  /** @hidden */
  passwordHash: string;
};
```

| Tag | Applies to | What it does |
| --- | --- | --- |
| [`@unique`](/reference/tags/#unique) | Top-level fields that are not arrays or objects | Rejects a value another record already has, with 409. |
| [`@index`](/reference/tags/#index) | Top-level fields that are not arrays or objects | Creates a database index for faster filters and sorting. |
| [`@default`](/reference/tags/#default) | Any field | Value used when a create body leaves the field out, written as a JSON literal or in single quotes (`'member'`, `0`, `true`, `[]`). |
| [`@minLength`](/reference/tags/#minlength) | Strings and arrays | Minimum length of a string, or minimum number of items. |
| [`@maxLength`](/reference/tags/#maxlength) | Strings and arrays | Maximum length of a string, or maximum number of items. |
| [`@minItems`](/reference/tags/#minitems) | Arrays and reference arrays | Minimum number of items. |
| [`@maxItems`](/reference/tags/#maxitems) | Arrays and reference arrays | Maximum number of items. |
| [`@min`](/reference/tags/#min) | Numbers | Smallest accepted number. |
| [`@max`](/reference/tags/#max) | Numbers | Largest accepted number. |
| [`@format`](/reference/tags/#format) | Strings | Checks for an `email` or a `url`. |
| [`@hidden`](/reference/tags/#hidden) | Any field | Never returns the field; `@hidden:list` and `@hidden:read` hide it only there. See [Field selection and hidden fields](/guides/field-selection/). |
| [`@onDelete`](/reference/tags/#ondelete) | References and reference arrays | What happens to this record when the referenced one is deleted. |
| [`@inverse`](/reference/tags/#inverse) | References and reference arrays | Pairs the field with a field of the other entity into one relation. |
| [`@owner`](/reference/tags/#owner) | Single references in a 1-1 relation | Marks the side that stores the reference. |
| [`@joinTable`](/reference/tags/#jointable) | Reference arrays | Names the junction table of a reference array or N-N relation. |
| [`@onConflict`](/reference/tags/#onconflict) | Single references in a 1-1 relation | With `replace`, moves a 1-1 link instead of failing with 409. |
| [`@maxSize`](/reference/tags/#maxsize-1) | References to file entities | Largest file the field accepts. |
| [`@accept`](/reference/tags/#accept-1) | References to file entities | MIME types the field accepts. |
| [`@maxTotalSize`](/reference/tags/#maxtotalsize) | Reference arrays of file entities | Largest total size uploaded to the field in one request. |
| [`@keepFile`](/reference/tags/#keepfile) | References to file entities | Never deletes the referenced file when it is replaced or the record is deleted. |

Tags are checked at build time: an unknown tag, a tag on the wrong field type, or a minimum greater than its maximum stops the build.

```text
entities/Post.ts: field "n" has unknown tag @colour
entities/Post.ts: field "n" has invalid @min: only applies to number fields
```

## What gets generated

`quickservicets build` (also run by `dev`) reads `entities/` and generates, for each entity that is not `@internal`, six routes:

| Method and path | Operation | Success status |
| --- | --- | --- |
| `GET /products` | list | 200 |
| `GET /products/:id` | read | 200 |
| `POST /products` | create | 201 |
| `PUT /products/:id` | replace | 200 |
| `PATCH /products/:id` | update | 200 |
| `DELETE /products/:id` | delete | 204 |

It also generates:

- **Validation** of every create, replace and update body, from the field types and tags. See [Validation and error messages](/guides/validation/).
- **Repositories** for endpoints and hooks, such as `repos.products`, typed with the types in `.generated/types.ts`.
- **Migrations**: `quickservicets migration add <name>` writes the SQL (or MongoDB) changes for the entities into `migrations/`, and `quickservicets migrate` applies them. See the [CLI reference](/reference/cli/).
- **API docs** at `/openapi.json` and `/docs`.

For the `User` entity above, `.generated/types.ts` contains these types (an excerpt). `UserCreate` and `UserUpdate` type the bodies of `create`/`replace` and `update`, and the hidden `passwordHash` is optional in `User` because reads leave it out:

```ts check title=".generated/types.ts"
// Generated by quickservicets build. Do not edit.
import type { Many, One, Repository } from "@quickservicets/core";

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name: string;
  age?: number | null;
  role: "member" | "admin";
  tags: Array<string>;
  passwordHash?: string | null;
};

export type UserCreate = {
  email: string;
  name: string;
  age?: number | null;
  role?: "member" | "admin";
  tags?: Array<string>;
  passwordHash: string;
};

export type UserUpdate = {
  email?: string;
  name?: string;
  age?: number | null;
  role?: "member" | "admin";
  tags?: Array<string>;
  passwordHash?: string;
};

export type UserReferences = Record<never, never>;

export interface GeneratedRepositories {
  users: Repository<User, UserReferences, UserCreate, UserUpdate>;
}

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

The generated routes accept paging, sorting, filters, field selection and populate; see the [HTTP query parameters reference](/reference/http/). The repository methods are in the [repository API reference](/reference/api/).

**Next:** [Enums and union aliases](/guides/enums/)
