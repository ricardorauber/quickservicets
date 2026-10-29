---
title: Introduction
description: What QuickService.ts is and how it turns TypeScript types into a REST API.
sidebar:
  order: 1
---

QuickService.ts is a backend framework for [Bun](https://bun.sh). You describe your data as plain TypeScript types, and it generates a typed, validated and documented REST API for them.

There are no decorators, schemas or classes to keep in sync. The type is the model.

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

From this one file you get list, read, create, update, replace and delete routes for `/users`, with validation, filters, sorting, paging and an OpenAPI page at `/docs`.

## How it works

A project has three folders you write, and one the framework writes:

1. **`entities/`** holds one type per file. JSDoc tags such as `@unique` or `@default` add rules.
2. **`endpoints/`** and **`hooks/`** hold your own routes and the code that runs before or after them. Both are optional.
3. **`quickservicets build`** reads those folders and writes **`.generated/`**: the models, the TypeScript types, the route table, the OpenAPI document and a `server.ts` entry.
4. **`bun .generated/server.ts`** starts the API.

While you work, `quickservicets dev` does steps 3 and 4 for you, and rebuilds and restarts whenever a file changes.

## What you get

- **Generated CRUD.** Six routes per entity, with `limit`/`offset` paging, `sort`, `where[<field>][<op>]` filters, `fields`/`exclude` selection and `populate`. See [HTTP query parameters](/reference/http/).
- **Validation.** Types, required fields, enums, lengths, ranges and formats are checked on every write, with one consistent [error shape](/reference/errors/).
- **Relations.** Fields that point to other entities, arrays of references, and two-sided relations kept in sync.
- **Files.** Built-in `File` and `Media` entities, built when an entity references them, multipart uploads, local or S3-compatible storage, and direct, proxied or signed URLs.
- **Custom endpoints and hooks.** File-based routes like `endpoints/users/[id]/stats/get.ts`, and hooks you apply with a tag.
- **Typed repositories.** `repos.users.findById(...)` and a fluent query API, typed from your entities. See [Repositories and queries](/reference/api/).
- **Migrations.** Generated from model changes for SQLite, PostgreSQL and MongoDB.
- **API docs.** An OpenAPI 3.1 document at `/openapi.json` and a Scalar page at `/docs`.
- **Four databases.** In-memory, SQLite, PostgreSQL and MongoDB, chosen in [the configuration](/reference/config/).

Every tag is listed in [JSDoc tags](/reference/tags/), and every command in [CLI](/reference/cli/).

## Next

[Installation and `init`](/getting-started/installation/): create your first project.
