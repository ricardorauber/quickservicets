# QuickService.ts

> Write your entities as TypeScript types. Get a typed, documented REST API on Bun.

**Entities as types**
Describe your data with plain `type` declarations and JSDoc tags like `@unique` and `@default`.

**Generated CRUD**
List, read, create, update, replace and delete routes with validation, filters, sorting and populate.

**Typed queries**
A LINQ-like API: `where`, `include`, `orderBy`, `toArray`, `any`, `all` — checked by TypeScript end to end.

**API docs**
An OpenAPI 3.1 document and a Scalar page at `/docs`, generated from the same model.

## A complete API from one file

```ts title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

And it answers right away:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@x.co"}'
# {"id":"01a1…","email":"ana@x.co","name":null,"role":"member",…}
```

## Install

In any folder, with [Bun](https://bun.sh) installed:

```bash
bunx quickservicets init my-app --db sqlite
cd my-app
bun install
bun run dev
```

The [Getting started](/getting-started/) section walks through it.
