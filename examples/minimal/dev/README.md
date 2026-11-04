# dev

The smallest project that shows the `dev` native: one command starts the PostgreSQL the project uses, in Docker, and runs the development server connected to it.

```bash
bun run quickservicets dev --services
```

It writes `.generated/dev/compose.yml`, runs `docker compose up -d --wait`, prints `Service database (postgres:17.11-alpine) on localhost:5432`, writes `DATABASE_URL` to `.env` when `.env` does not set it, and starts `quickservicets dev`. `bun run test` checks the compose document without Docker.

## Level 0: enable

The native is enabled by default; with no `dev` key the command starts every service the project needs:

```bash
bun run quickservicets dev --services
bun run quickservicets services env
```

## Level 1: options and environment

Move PostgreSQL to another host port, wait longer for the health checks, or choose the compose project name:

```ts
export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/app" }),
  dev: { services: { database: { port: 5440 } }, wait: "2m", project: "blog" },
});
```

## Level 2: tags

Not applicable: local services are not tied to entities, fields or routes, so the native has no tags.

## Level 3: per request

Not applicable: local services are started by the CLI before the server runs, so no option depends on a request.

## Level 4: hooks and events

Not applicable: the native has no hooks yet; the compose document can be changed with the override file of level 5.

## Level 5: override files

`dev/compose.override.yml` is passed to Docker Compose after the generated file, so it changes or adds services:

```yaml
services:
  adminer:
    image: adminer:4.8.1
    ports: ["8080:8080"]
```

## Level 6: replace the implementation

Not applicable: the native calls `docker compose`; start the services yourself and set `DATABASE_URL` in `.env` to use another tool.

## Level 7: eject

```bash
bun run quickservicets eject dev
```

It copies the native into `features/dev/`, where the project owns its commands.
