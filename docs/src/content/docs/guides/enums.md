---
title: Enums and union aliases
description: Restrict a field to a fixed set of string values with unions, enums or shared aliases.
sidebar:
  order: 11
---

An enum field accepts one value from a fixed list of strings. You can write the list inline, as a TypeScript `enum`, or as a type alias that several entities share. All forms behave the same in requests, filters and the database; they differ only in how the generated code and the API docs name them.

## Four ways to write an enum

```ts check title="entities/enums.ts"
// A string enum: the values are the strings.
export enum Status {
  Draft = "draft",
  Published = "published",
}

// An enum without initializers: the member names are the values.
export enum Priority {
  low,
  normal,
  high,
}

// An alias of a string union.
export type Visibility = "public" | "private";
```

```ts check title="entities/Post.ts"
import { Priority, Status, type Visibility } from "./enums";

export type Post = {
  title: string;
  /** @default Status.Draft */
  status: Status;
  /** @default Priority.normal */
  priority: Priority;
  /** @default 'public' */
  visibility: Visibility;
  // An inline union.
  kind?: "news" | "opinion";
  labels?: Status[];
};
```

- **Inline union** (`"news" | "opinion"`): quickest for a list used by one field.
- **String enum** (`Status`): the values are the initializers, `"draft"` and `"published"`. In code you write `Status.Draft`.
- **Enum without initializers** (`Priority`): the values are the member names, `"low"`, `"normal"` and `"high"`. TypeScript numbers these members at runtime (`Priority.low` is `0`), but QuickService never uses the numbers.
- **Union alias** (`Visibility`): a named union without a runtime object.

Enums and aliases also work in arrays (`labels?: Status[]`) and inside nested objects (`meta: { status: Status }`).

## Where to declare them

An enum or alias can live in the entity file, in any other file of the project (such as `shared/visibility.ts`), or in a file of its own inside `entities/`. A file in `entities/` that exports only enums and string unions, like `entities/enums.ts` above, is shared by entities and is not an entity itself, so its name does not have to be PascalCase.

Whatever the place, the declaration must be **exported**. The build rejects enums it cannot use, naming the file, the field and the enum:

```text
entities/Post.ts: field "status" uses Status, which must be exported
entities/Post.ts: field "level" uses enum Level, whose members must all have string values or all have none
entities/Post.ts: field "s" uses enum Status, which repeats the value "x"
```

The second message covers numeric initializers (`enum Level { Low = 1 }`) and enums that mix members with and without values (`enum Level { Low, High = "high" }`).

## Defaults

[`@default`](/reference/tags/#default) takes either the value, in single quotes, or a member of the field's own enum:

- `/** @default 'draft' */` and `/** @default Status.Draft */` both give `"draft"`.
- `/** @default Priority.normal */` gives `"normal"`.
- A member that does not exist, or a member of another enum, stops the build with an invalid `@default` error.

## In requests and filters

Clients always send and receive the values, never member names of string enums and never numbers. With the `Post` entity above, the defaults fill in what the body leaves out:

```bash
curl -X POST localhost:3000/posts -d '{"title":"Hello"}'
```

```json
{
  "title": "Hello",
  "status": "draft",
  "priority": "normal",
  "visibility": "public",
  "id": "01a146db-1bd4-72f5-85a9-db325b08d9e7",
  "createdAt": "2026-10-16T22:35:27.060Z",
  "updatedAt": "2026-10-16T22:35:27.060Z",
  "kind": null,
  "labels": null
}
```

A member name (`"Draft"`), a number, or an unknown value fails with the list of accepted values:

```bash
curl -X POST localhost:3000/posts -d '{"title":"Bye","status":"Draft","priority":2,"labels":["draft","archived"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "status", "message": "Must be one of: draft, published" },
      { "field": "priority", "message": "Must be one of: low, normal, high" },
      { "field": "labels[1]", "message": "Must be one of: draft, published" }
    ]
  }
}
```

Filters use the values too. After also creating a post with `"status": "published"`, `"priority": "high"` and the title `Launch`:

```bash
curl "localhost:3000/posts?where[status][eq]=published&fields=title,status,priority"
```

```json
{
  "data": [{ "title": "Launch", "status": "published", "priority": "high" }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```bash
curl "localhost:3000/posts?where[priority][eq]=2"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [{ "field": "where[priority][eq]", "message": "Must be one of: low, normal, high" }]
  }
}
```

The operators each enum field takes are listed in the [HTTP query parameters reference](/reference/http/#filter-operators-by-field-type).

## Generated types

The build types enum fields with your declarations, so code uses them directly. This is the `Post` part of `.generated/types.ts` (an excerpt):

```ts check title=".generated/types.ts"
// Generated by quickservice build. Do not edit.
import type { Many, One, Repository } from "@quickservice/core";
import type { Status } from "../entities/enums.ts";
import type { Visibility } from "../entities/enums.ts";

export type Post = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  status: Status;
  priority: "low" | "normal" | "high";
  visibility: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostCreate = {
  title: string;
  status?: Status;
  priority?: "low" | "normal" | "high";
  visibility?: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostUpdate = {
  title?: string;
  status?: Status;
  priority?: "low" | "normal" | "high";
  visibility?: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostReferences = Record<never, never>;

export interface GeneratedRepositories {
  posts: Repository<Post, PostReferences, PostCreate, PostUpdate>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

- String enums and aliases are imported and used by name: `status: Status`.
- Enums without initializers become the union of their names (`"low" | "normal" | "high"`), because their runtime members are numbers.
- Inline unions stay inline unions.

So in an endpoint you write `Status.Published` for a string enum and the plain name for an enum without initializers:

```ts check title="endpoints/posts/announcements/post.ts"
import type { Endpoint } from "@quickservice/core";
import { Status } from "../../../entities/enums";

/** @summary Publish an urgent announcement */
const handler: Endpoint<{ title: string }> = async (repos, req, res) => {
  const { title } = await req.json();
  res.status(201);
  return repos.posts.create({ title, status: Status.Published, priority: "high" });
};

export default handler;
```

```bash
curl -X POST localhost:3000/posts/announcements -d '{"title":"We are live"}'
```

```json
{
  "title": "We are live",
  "status": "published",
  "priority": "high",
  "visibility": "public",
  "id": "01a146d9-b620-7150-9cce-56f6470a4771",
  "createdAt": "2026-10-16T22:33:55.493Z",
  "updatedAt": "2026-10-16T22:33:55.493Z",
  "kind": null,
  "labels": null
}
```

Writing the member of an enum without initializers is a type error, because `Priority.high` is the number `2`:

```ts
repos.posts.create({ title, priority: Priority.high });
// error TS2322: Type 'Priority.high' is not assignable to type '"normal" | "high" | "low" | undefined'.
```

## In the API docs

Each named enum or alias appears once in the OpenAPI document, as a shared schema under `components.schemas`, and every field that uses it points there with `$ref`, in responses, request bodies, nested fields and array items. Inline unions stay inline. For the `Post` entity:

```json
{
  "Status": { "type": "string", "enum": ["draft", "published"] },
  "Priority": { "type": "string", "enum": ["low", "normal", "high"] },
  "Visibility": { "type": "string", "enum": ["public", "private"] }
}
```

```json
{
  "status": { "$ref": "#/components/schemas/Status", "default": "draft" },
  "priority": { "$ref": "#/components/schemas/Priority", "default": "normal" },
  "visibility": { "$ref": "#/components/schemas/Visibility", "default": "public" },
  "kind": { "type": ["string", "null"], "enum": ["news", "opinion", null] },
  "labels": { "type": ["array", "null"], "items": { "$ref": "#/components/schemas/Status" } }
}
```

An optional field that uses a named enum directly, such as `visibility?: Visibility`, is documented as `oneOf` the `$ref` and `{ "type": "null" }`. When an enum's name clashes with another schema of the document (an entity, another enum with the same name, or a generated name like `UserCreate` or `Error`), its fields fall back to an inline `enum`.

**Next:** [Validation and error messages](/guides/validation/)
