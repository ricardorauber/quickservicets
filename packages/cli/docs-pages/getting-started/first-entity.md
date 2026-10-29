# Your first entity

> Describe a user as a TypeScript type and start the API.

An entity is a TypeScript type in `entities/`. This page adds a `User` to the `my-api` project from the [previous page](/getting-started/installation/) and starts the server.

## Write the entity

Create `my-api/entities/User.ts`:

```ts title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @maxLength 80 */
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

That is the whole entity. Here is what each part does:

- **The file name and the type name match.** Each file in `entities/` exports one entity, named like the file (`User.ts` exports `User`).
- **The routes use the plural.** `User` becomes the collection `users`, served at `/users`. The [`@collection`](/reference/tags/#collection) tag picks another name.
- **`email`** is required. `@unique` rejects a second user with the same email, and `@format email` checks its shape.
- **`name?`** is optional, and `@maxLength 80` limits its length. When it has no value, responses show `null`.
- **`role`** only accepts `"member"` or `"admin"`. `@default 'member'` fills it in when a request leaves it out.

You never declare `id`, `createdAt` or `updatedAt`. Every entity gets them: the `id` is a UUID v7, `createdAt` is set when the record is created, and `updatedAt` every time it changes.

Every tag is listed in the [JSDoc tags reference](/reference/tags/).

## Start the server

```bash
cd my-api
bun run dev
```

```text
$ quickservicets dev
Built 1 entity, 0 custom endpoints and 0 hooks.
QuickService.ts listening on http://localhost:3000
```

`dev` builds the project, starts the server, and rebuilds and restarts it every time you save a file in `entities/`, `endpoints/`, `hooks/`, `jobs/`, `features/`, the config or a `.env` file. Set `PORT` to use another port, for example `PORT=4000 bun run dev`. Each request then logs one JSON line in this terminal.

> **Tip:**
>
> You can also build and start in two steps, which is what you would do in production:
>
> ```bash
> bun run build
> bun run start
> ```
>
> `build` prints `Built 1 entity, 0 custom endpoints and 0 hooks.` The count is the entities really in the model: the built-in `File` and `Media` entities are built only when an entity references them or the config sets `storage` (see [Files](/guides/files/)).

## What the build generated

The build wrote `.generated/`. Among other things, it holds the types for your entity, which your endpoints and hooks use:

```ts
// From .generated/types.ts
export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name?: string | null;
  role: "member" | "admin";
};

export type UserCreate = {
  email: string;
  name?: string | null;
  role?: "member" | "admin";
};

export type UserUpdate = {
  email?: string;
  name?: string | null;
  role?: "member" | "admin";
};
```

`UserCreate` makes `role` optional because it has a default, and `UserUpdate` makes every field optional because an update may change any of them.

## The routes you get

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/users` | Lists users, with paging, filters and sorting |
| `GET` | `/users/<id>` | Reads one user |
| `POST` | `/users` | Creates a user |
| `PATCH` | `/users/<id>` | Changes some fields |
| `PUT` | `/users/<id>` | Replaces the whole user |
| `DELETE` | `/users/<id>` | Deletes the user |

Open [http://localhost:3000/docs](http://localhost:3000/docs) to browse them. The page is built from the OpenAPI document at `/openapi.json`, which the build generates from the same model.

## About the memory database

The memory database keeps everything in the server process, so the data is gone after each restart, including the restarts `dev` does when you save a file.

It also needs no migrations. `bun run migrate` just prints `Nothing to migrate: the memory adapter keeps no schema`. With SQLite, PostgreSQL or MongoDB, you create and apply migrations with the [`migration add` and `migrate` commands](/reference/cli/).

## Next

[Your first requests](/getting-started/first-requests/): create, list, read, update and delete users with `curl`.
