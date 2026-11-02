# saas-projects

A multi-tenant project manager: each customer signs up for a workspace on a plan, and gets projects, tasks and comments that no other workspace can see. It is the showcase of the `tenancy` native with PostgreSQL, the `secrets` native for the template of tenant databases, and `queues` with the transactional outbox for background work in every workspace.

## The domain

- `Project` (`name`, `archived`), `Task` (`project`, `title`, `status` of `todo`, `doing` and `done`, `assigneeId`, `dueAt?`) and `Comment` (`task`, `authorId`, `body`) are tenant data: each workspace has its own.
- `Plan` (`slug`, `maxProjects`, `maxMembers`) and `Member` (`tenantKey`, `userId`, `role` of `owner`, `admin` and `member`) are shared by every workspace (`@tenancy shared`).
- `entities/Tenant.ts` adds `billingEmail` and `planSlug` to the native's tenant fields.
- `POST /signup` provisions a workspace on a plan and makes the caller its owner; `hooks/planLimit.ts` refuses a project beyond the plan's `maxProjects` with `402 PLAN_LIMIT_REACHED`.
- `POST /tasks/:id/remind` queues a reminder, which `queues/remind.ts` turns into a comment, in the workspace that queued it.

## The tenancy design

Plans choose the strategy: `free` and `pro` workspaces share the service's database, each in a schema of its own (`tenant_acme`, `tenant_globex`), which is cheap and still keeps every request away from other workspaces' tables; the `enterprise` plan gets a database of its own (`initech`), for stronger isolation, its own backups and a server of its own if needed:

```ts
tenancy: {
  from: ["subdomain", "header"],
  domain: process.env.APP_DOMAIN ?? "saas.localhost",
  strategy: ({ tenant }) => (tenant?.plan === "enterprise" ? "database" : "schema"),
  connection: secret("env://TENANT_DATABASE_TEMPLATE"),
},
```

The connection of enterprise databases is a template with `{tenant}`, like `postgres://saas:saas@postgres:5432/saas_{tenant}`, read from `TENANT_DATABASE_TEMPLATE` through the `secrets` native, so it never appears in the configuration. Plans and memberships are shared: the sign-up page lists the plans without a workspace, and a user can belong to several workspaces. Users themselves live in an identity provider (authentication comes in a later phase), so tasks, comments and members only keep user ids, never a copy of the user.

A workspace is found from the subdomain (`acme.saas.localhost`) or the `x-tenant-id` header. Background work stays in its workspace: a queue message added in `initech` is staged in initech's database with its write and relayed to the service's queue by the outbox, then processed in initech again.

## Running it with Docker Compose

`docker-compose.yml` starts PostgreSQL with two databases, `saas` for the service and `saas_initech` for the enterprise workspace (`docker/create-databases.sql`), and the service, which migrates the service's database and every workspace at each start:

```bash
docker compose -f examples/saas-projects/docker-compose.yml up --build -d
docker compose -f examples/saas-projects/docker-compose.yml exec app bun scripts/seed.ts
```

`SAAS_PORT=3300` publishes the service on another host port when 3000 is taken. The seed creates the plans `free` (3 projects, 5 members), `pro` (50, 100) and `enterprise` (unlimited), and the workspaces `acme` (free), `globex` (pro) and `initech` (enterprise, in `saas_initech`), each with sample projects and tasks. Without Docker, run PostgreSQL yourself and:

```bash
export DATABASE_URL=postgres://saas:saas@localhost:5432/saas TENANT_DATABASE_TEMPLATE=postgres://saas:saas@localhost:5432/saas_{tenant}
bun install && bun run build && bun run migrate && bun run seed && bun run start
```

## Sign-up and requests

```bash
curl -X POST localhost:3000/signup -H 'content-type: application/json' -d '{"workspace":"hooli","plan":"free","owner":"gavin"}'
# {"id":"hooli"}; a second sign-up of hooli answers 409 Workspace already exists
curl localhost:3000/projects -H 'x-tenant-id: hooli'
# {"data":[],"total":0,"limit":20,"offset":0}
curl localhost:3000/projects -H 'host: acme.saas.localhost'
curl -X POST localhost:3000/projects -H 'x-tenant-id: acme' -H 'content-type: application/json' -d '{"name":"Fourth"}'
# 402 PLAN_LIMIT_REACHED: Your plan allows 3 projects (acme is on free)
curl -X POST localhost:3000/projects -H 'x-tenant-id: globex' -H 'content-type: application/json' -d '{"name":"Fourth"}'
curl localhost:3000/plans
```

## Tests

`bun test` runs the sign-up and its 409, the plan limit, the subdomain and header forms, where each strategy puts the data, a reminder relayed and processed in `initech`, and `runTenantIsolationSuite` with the showcase's entities, on the memory adapter. With `TEST_POSTGRES_URL` (and `TEST_MONGODB_URL` for the isolation suite) set, it also builds, migrates and seeds the showcase on PostgreSQL and checks that acme's and globex's tables are in their schemas and initech's in its own database.

## Roadmap

The later phases of the showcase add authentication with real users, roles per workspace and the member limit, usage metrics per workspace, realtime task boards, delivery files for container platforms, usage billing with Stripe (the tenant's `stripeCustomerId`), the admin panel and backups.
