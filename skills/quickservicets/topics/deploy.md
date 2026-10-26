# Deploy

How to build, migrate and run a QuickService.ts service in production, in a container or on a host with Bun.

## Steps

1. Use PostgreSQL or MongoDB in production (SQLite works for a single process on one host).
2. Install, build and type-check:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
```

3. Apply the migrations against the production database, once per release, before the new version serves traffic:

```bash
NODE_ENV=production bun run quickservicets migrate
```

4. Start the last build:

```bash
NODE_ENV=production bun run start
```

`bun run start` runs `bun .generated/server.ts`. It listens on `PORT` (default 3000), or `server.port`.

## Production settings

- `NODE_ENV=production` turns on production mode: 500 responses hide details, the API docs are off unless `docs.enabled` is `true`, and `migrate` refuses to revert without `--force`.
- With PostgreSQL or MongoDB on Linux, production mode runs one worker per CPU (`server.workers` defaults to `"auto"`); set `QS_WORKERS=1` for a single process.
- Set secrets and connection settings as environment variables of the host, not in files; `bun run quickservicets env check` verifies them.
- Turn on `health: {}` for `/health/live` and `/health/ready`, the routes for orchestrators and load balancers.
- `SIGTERM` shuts the service down gracefully, letting running jobs finish.

## Container

```dockerfile
FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "start"]
```

Run `bun run quickservicets migrate` as a separate release step (a job or an init container) with the same image and environment, before the new containers start.

## Releases

1. `bun run build` and `bun test` in CI.
2. `bun run quickservicets migrate` against the production database.
3. Roll out the new containers.

To roll back a migration, run `bun run quickservicets migrate <target> --force` with the id of the last migration to keep (`bun run quickservicets migration list` shows them).

Full docs: [Configuration](/guides/configuration/) and [Migrations](/guides/migrations/).

## Do not

- Do not run `bun run dev` in production; it watches files and rebuilds.
- Do not use the memory database in production; its data is lost on restart.
- Do not run more than one worker with SQLite or the memory database; the server refuses to start.
- Do not ship `.env` files or `.generated/` from a developer machine; build in CI or in the image.
- Do not let several replicas run `migrate` at the same time; run it once per release.
