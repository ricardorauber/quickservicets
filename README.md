# QuickService.ts

[![quickservicets on npm](https://img.shields.io/npm/v/quickservicets?label=quickservicets)](https://www.npmjs.com/package/quickservicets)
[![@quickservicets/core on npm](https://img.shields.io/npm/v/@quickservicets/core?label=%40quickservicets%2Fcore)](https://www.npmjs.com/package/@quickservicets/core)
[![@quickservicets/cli on npm](https://img.shields.io/npm/v/@quickservicets/cli?label=%40quickservicets%2Fcli)](https://www.npmjs.com/package/@quickservicets/cli)

Build backend services from TypeScript entity types. Write an entity as a `type` with JSDoc tags in `/entities`, and QuickService.ts generates its CRUD routes, validation, filters, relations, file uploads, migrations and OpenAPI docs, on Bun with an in-memory, SQLite, PostgreSQL or MongoDB database.

The source lives at [github.com/ricardorauber/quickservicets](https://github.com/ricardorauber/quickservicets).

This monorepo holds `@quickservicets/core` (runtime), `@quickservicets/cli` (the `quickservicets` command), `quickservicets` (which runs that command with `bunx quickservicets`) and examples in `examples/`.

## A quick look

### An entity is a type

```ts
// entities/User.ts
export type User = {
  /** @unique @format email */
  email: string;
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

```ts
// entities/Organization.ts
import type { User } from "./User";

/** @authorized:create,update,replace,delete admin */
export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  plan: "free" | "pro";
  members: User[];
  owner?: User;
};
```

`bun run build` turns these into list, read, create, update, replace and delete routes, with validation, a migration, typed repositories and an OpenAPI document served at `/docs`.

### The API answers right away

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@x.co"}'
# {"id":"01a1…","email":"ana@x.co","name":null,"role":"member",…}

curl -g "localhost:3000/users?where[role][eq]=admin&sort=-createdAt&limit=10"
curl "localhost:3000/organizations?populate=owner,members&fields=name,owner.email"
curl -X POST localhost:3000/users -d '{"email":"not-an-email"}'
# 400 VALIDATION_ERROR, naming the field and the rule
```

`-g` keeps curl from reading the square brackets of filters as a URL pattern.

### Custom endpoints are files

The folder path is the route, Next.js style, and the handler gets typed repositories:

```ts
// endpoints/organizations/[orgId]/stats/get.ts
import { HttpError, type Endpoint } from "@quickservicets/core";

/** @summary Organization stats */
const handler: Endpoint<unknown, { members: number; admins: number }> = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.orgId!);
  if (!organization) throw new HttpError(404, "Organization not found");
  const admins = await repos.users.where((u) => u.id.in(organization.members).and(u.role.eq("admin"))).count();
  return { members: organization.members.length, admins };
};

export default handler;
```

### Tags run hooks

`@authorized:create,update,replace,delete admin` on `Organization` runs this pre-hook before those routes:

```ts
// hooks/authorized.ts
import { definePreHook, HttpError } from "@quickservicets/core";
import { verifyToken } from "../lib/auth"; // your JWT or session check

export default definePreHook(async (repos, req, _res, roles) => {
  const email = await verifyToken(req.headers.get("authorization"));
  const user = email ? await repos.users.where((u) => u.email.eq(email)).firstOrDefault() : null;
  if (!user) throw new HttpError(401, "Authentication required");
  if (roles.length > 0 && !roles.includes(user.role)) throw new HttpError(403, `Requires role: ${roles.join(" or ")}`);
  req.context.user = user;
});
```

### Jobs are files too

```ts
// jobs/daily-signups.ts
import { job } from "@quickservicets/core";

export default job("0 8 * * *", async ({ repos, log }) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const signups = await repos.users.where((u) => u.createdAt.gt(since)).count();
  log.info("Daily signups", { signups });
  return { signups };
});
```

Every run is recorded with its result, and `quickservicets job runs` lists them.

### Everything else is a feature you switch on

```ts
// quickservicets.config.ts
import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  events: {},  // entity write events with a transactional outbox
  history: {}, // every version of the entities tagged @history
  queues: {},  // database queues with retries, delays, priorities and a dead letter
});
```

Security headers, CORS, request limits, timeouts, load shedding and rate limiting are on by default (`@rateLimit 5/min` tunes one route). History, Server-Sent Events change streams, health checks, idempotency keys, ETags, error reporting and feature flags are natives too. Each one works with `{}`, takes `QS_*` environment overrides, has entity and route tags, and can be replaced or ejected; the [features reference](docs/src/content/docs/reference/features/index.md) lists them.

## Documentation

The developer documentation is a Starlight site in `docs/`:

```bash
bun run docs:dev     # serves it at http://localhost:4321
bun run docs:build   # builds the static site into docs/dist
```

## Getting started

Create a project in any folder with [Bun](https://bun.sh) 1.4.2 or later:

```bash
bunx quickservicets init my-api --db sqlite
cd my-api
bun install
bun run dev
```

To build a first project step by step, follow the [Getting started](docs/src/content/docs/getting-started/index.md) section of the docs (served at http://localhost:4321/getting-started/ by `bun run docs:dev`). It covers installing, creating a project with `init`, writing a first entity and calling its API.

## Features

Everything beyond the generated API is a feature turned on by a key in `quickservicets.config.ts`. A project can write its own in `features/<key>/`, with the same extension points as the framework's native features, or replace a native with one; the [Project features](docs/src/content/docs/guides/project-features.md) guide shows how.

## Using PostgreSQL or MongoDB

Run `init` with `--db postgres` or `--db mongodb` and set the values in the `.env` it creates: `DATABASE_URL`, plus `DATABASE_NAME` for MongoDB.

A quick local PostgreSQL:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16
# DATABASE_URL=postgres://postgres:pass@localhost:5432/postgres
```

MongoDB has to run as a replica set, because writes that update both sides of a relation use transactions.

## Running the tests

```bash
bun test
```

Tests against real databases and S3 run only when these are set; otherwise they are skipped:

- `TEST_POSTGRES_URL`
- `TEST_MONGODB_URL`
- `TEST_S3_BUCKET`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`

Type-check every project of the repository (the test suite runs this too):

```bash
bun run typecheck
```

Two more checks guard contributions. `bun run typecheck` also fails when code outside `packages/core/src/adapters/` passes SQL text built at runtime to `unsafe()`: pass values as parameters, or put `// quickservicets-allow-unsafe: <reason>` on the line above a call that must build its text. `bun run audit` runs `bun audit` and fails on a critical vulnerability unless `scripts/audit-allow.json` lists it with an id, package, reason and `expires` date; the test suite runs it when `CI` is set.
