# QuickService

Build backend services from TypeScript entity types. Write an entity as a `type` with JSDoc tags in `/entities`, and QuickService generates its CRUD routes, validation, filters, relations, file uploads, migrations and OpenAPI docs, on Bun with an in-memory, SQLite, PostgreSQL or MongoDB database.

This monorepo holds `@quickservice/core` (runtime), `@quickservice/cli` (the `quickservice` command) and examples in `examples/`.

## Documentation

The developer documentation is a Starlight site in `docs/`:

```bash
bun run docs:dev     # serves it at http://localhost:4321
bun run docs:build   # builds the static site into docs/dist
```

## Trying it out

The packages are not published to npm yet, so a test project has to live inside this monorepo, under `examples/`, and use the workspace packages.

### 1. Create a project

```bash
bun packages/cli/src/index.ts init examples/my-test --db sqlite
```

`--db` takes `sqlite`, `postgres`, `mongodb` or `memory`. Then, in `examples/my-test/package.json`, replace both `"^0.1.0"` versions with `"workspace:*"` and run `bun install` at the monorepo root.

If the editor reports `Cannot find module '@quickservice/core'`, this step is missing. After fixing it, run **TypeScript: Restart TS Server** in the editor.

Also, in `examples/my-test/tsconfig.json`, replace `".generated"` in `include` with `".generated/**/*.ts"`. TypeScript skips folders whose name starts with a dot, so without this change endpoints and hooks see untyped repositories (`Property 'users' does not exist on type 'Repositories'`).

### 2. Add entities

`examples/my-test/entities/User.ts`:

```ts
export type User = {
  /** @unique @format email */
  email: string;
  /** @hidden */
  passwordHash: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

`examples/my-test/entities/Organization.ts`:

```ts
import type { Media } from "@quickservice/core";
import type { User } from "./User.ts";

export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  /** @maxSize 1MB @accept image/png,image/jpeg */
  logo?: Media;
  members: User[];
};
```

#### Enums

An enum field can be written in any of these forms, as long as the values are strings:

```ts
// An inline union
role: "member" | "admin";

// A string enum
export enum Status { Draft = "draft", Published = "published" }

// An enum without initializers: the member names are the values ("manage", "view")
export enum ModuleAction { manage, view }

// An alias of a string union
export type Visibility = "public" | "private";
```

- Enums and aliases must be exported. They can live in the entity file, in any other file, or in their own file inside `entities/` (such as `entities/ModuleAction.ts`). A file that exports only enums or unions is shared by entities, not an entity itself.
- Clients, filters and the database always use the values (`"draft"`, `"manage"`), never numbers.
- `@default` takes a value or a member: `/** @default 'draft' */` or `/** @default Status.Draft */`.
- The build fails for enums that are not exported, that use numeric values, that mix members with and without values, or that repeat a value.
- In code, the generated types use the enum itself (`Status.Draft`). For an enum without initializers, use the names as strings (`"manage"`), because `ModuleAction.manage` is the number `0` at runtime and the generated types reject it.
- The API docs show each named enum once, as a shared schema (`components.schemas.Status`).

### 3. Migrate and start the server

```bash
cd examples/my-test
bun run quickservice migration add Initial
bun run quickservice migrate
bun run dev
```

The server listens on port 3000; set `PORT` to use another one. It reloads when entities, endpoints or hooks change.

### 4. Call the API

Open the API docs at http://localhost:3000/docs, or get the raw document at `/openapi.json`.

Create a user (`passwordHash` is hidden from responses):

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@x.co","passwordHash":"h"}'
```

Create an organization and upload its logo in one multipart request (use the user id returned above):

```bash
curl -X POST localhost:3000/organizations \
  -F name=Acme -F slug=acme -F members=<user-id> -F "logo=@./logo.png;type=image/png"
```

Read with populate, filters and field selection:

```bash
curl "localhost:3000/organizations?populate=logo,members"
curl "localhost:3000/users?where[email][contains]=ana&fields=email,role"
```

The logo's `url` (`/media/<id>/file`) serves the file.

### 5. Custom endpoints and hooks

- Endpoints use Next.js-style paths, for example `endpoints/organizations/[orgId]/stats/get.ts`. A file whose path matches a generated route replaces it.
- Hooks live in `/hooks`, for example `hooks/authorized.ts` exporting `definePreHook(...)`. Apply one by tagging an entity or endpoint with `@authorized`.
- Endpoints and hooks receive typed repositories. `repos.users.create(...)` and `repos.users.update(...)` take `UserCreate` and `UserUpdate`, which the build generates in `.generated/types.ts`.

#### Example: custom endpoints

An endpoint file default-exports a function that receives the repositories, the request and the response controls, and returns the response body. Typing it as `Endpoint<Body, Result>` types `req.json()` and the return value, and documents both in `/docs`. `@summary` and `@description` also appear in the docs.

`examples/my-test/endpoints/organizations/[orgId]/stats/get.ts`, serving `GET /organizations/:orgId/stats`:

```ts
import { HttpError, type Endpoint } from "@quickservice/core";

type Stats = { members: number; createdDaysAgo: number };

/**
 * @summary Organization stats
 * @description Counts the members of an organization and how old it is.
 */
const handler: Endpoint<unknown, Stats> = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.orgId!);
  if (!organization) throw new HttpError(404, "Organization not found");
  const days = Math.floor((Date.now() - organization.createdAt.getTime()) / 86_400_000);
  return { members: organization.members.length, createdDaysAgo: days };
};

export default handler;
```

`examples/my-test/endpoints/organizations/[orgId]/members/post.ts`, serving `POST /organizations/:orgId/members` with a JSON body:

```ts
import { HttpError, type Endpoint } from "@quickservice/core";

type AddMember = { email: string };

/** @summary Add a member by email */
const handler: Endpoint<AddMember, { members: number }> = async (repos, req, res) => {
  const { email } = await req.json();
  const user = await repos.users.findOne([{ field: "email", op: "eq", value: email }]);
  if (!user) throw new HttpError(404, "User not found");
  const organization = await repos.organizations.update(req.params.orgId!, { members: { add: [user.id] } });
  res.status(201);
  return { members: organization.members.length };
};

export default handler;
```

`examples/my-test/endpoints/organizations/[orgId]/members/get.ts`, serving `GET /organizations/:orgId/members?search=ana&limit=10` with query items:

```ts
import { HttpError, type Endpoint } from "@quickservice/core";

type MemberList = { data: { id: string; email: string }[]; total: number };

/**
 * @summary List an organization's members
 * @description Optional query items: `search` (part of the email) and `limit` (1 to 100, default 20).
 */
const handler: Endpoint<unknown, MemberList> = async (repos, req) => {
  const search = req.query.get("search")?.trim() ?? "";
  const limit = Number(req.query.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "Invalid query", { details: [{ field: "limit", message: "Must be between 1 and 100" }] });
  }

  const organization = await repos.organizations.findById(req.params.orgId!);
  if (!organization) throw new HttpError(404, "Organization not found");
  if (organization.members.length === 0) return { data: [], total: 0 };

  const result = await repos.users.list({
    where: [
      { field: "id", op: "in", value: organization.members },
      ...(search ? [{ field: "email", op: "contains" as const, value: search, caseInsensitive: true as const, literal: true as const }] : []),
    ],
    sort: [{ field: "email", direction: "asc" }],
    limit,
    offset: 0,
  });
  return { data: result.data.map((user) => ({ id: user.id, email: user.email })), total: result.total };
};

export default handler;
```

```bash
curl -X POST localhost:3000/organizations/<org-id>/members -d '{"email":"ana@x.co"}'
# {"members":1} (201)
curl localhost:3000/organizations/<org-id>/stats
# {"members":1,"createdDaysAgo":0}
curl "localhost:3000/organizations/<org-id>/members?search=ANA&limit=10"
# {"data":[{"id":"...","email":"ana@x.co"}],"total":1}
curl "localhost:3000/organizations/<org-id>/members?limit=500"
# {"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"limit","message":"Must be between 1 and 100"}]}} (400)
```

- `req.params` holds the path segments in brackets, and `req.query` the query string (`URLSearchParams`: `get`, `getAll`, `has`). Query values are always strings, so convert and check them yourself.
- `repos.<entity>.list({ where, sort, limit, offset })` takes the same conditions as the `where[<field>][<op>]` filters of the generated list routes. For `contains` and `startsWith`, set `caseInsensitive: true` and `literal: true` to match like those routes do.
- The API docs do not list the query items of custom endpoints yet, so describe them in `@description`.
- Throwing `HttpError(status, message)` returns the standard error body, for example `{"error":{"code":"NOT_FOUND","message":"User not found"}}`.
- `res.status(...)` and `res.header(...)` change the response; returning `undefined` responds with 204.

## Using PostgreSQL or MongoDB

Run `init` with `--db postgres` or `--db mongodb` and set the values in the `.env` it creates: `DATABASE_URL`, plus `DATABASE_NAME` for MongoDB.

A quick local PostgreSQL:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16
# DATABASE_URL=postgres://postgres:pass@localhost:5432/postgres
```

MongoDB has to run as a replica set, because writes that update both sides of a relation use transactions.

## Cleaning up

Add `.generated/`, `data.db` and `uploads/` to the test project's `.gitignore` before committing it, or delete `examples/my-test` when you are done.

## Running the tests

```bash
bun test
```

Tests against real databases and S3 run only when these are set; otherwise they are skipped:

- `TEST_POSTGRES_URL`
- `TEST_MONGODB_URL`
- `TEST_S3_BUCKET`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`
