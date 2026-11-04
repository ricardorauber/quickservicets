# dev

The smallest project that shows the `dev` native: one command starts the PostgreSQL and the MinIO this project uses, in Docker, and runs the development server connected to them. The project stores `Post` records in PostgreSQL, uploads `Attachment` files to an S3 storage without an endpoint (MinIO locally), and consumes the `notify` queue.

```bash
bun run quickservicets dev --services
```

It writes `.generated/dev/compose.yml`, runs `docker compose up -d --wait`, prints one `Service <name> (<image>) on localhost:<port>` line per service, writes `DATABASE_URL` to `.env` when `.env` does not set it, and starts `quickservicets dev` with `S3_ENDPOINT` and the MinIO keys. `bun run test` checks the compose document without Docker and runs the project end to end on real PostgreSQL and MinIO containers when Docker is there (the test is skipped by name otherwise).

## Level 0: enable

The native is enabled by default; with no `dev` key the command starts every service the project needs:

```bash
bun run quickservicets dev --services
bun run quickservicets services env
```

## Level 1: options and environment

Move PostgreSQL to another host port and wait longer for the health checks; a `services` entry named after a kind reaches the only service of that kind, and every option has a `QS_DEV_*` variable:

```ts
export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/app" }),
  dev: { services: { postgres: { port: 5440 } }, wait: "2m" },
});
```

```bash
QS_DEV_SERVICES_POSTGRES_PORT=5441 QS_DEV_WAIT=3m bun run quickservicets dev --services
```

## Level 2: tags

Not applicable: local services are not tied to entities, fields or routes, so the native has no tags.

## Level 3: per request

Not applicable: local services are started by the CLI before the server runs, so no option depends on a request.

## Level 4: hooks and events

`beforeCompose` changes the compose document before it is written, here adding Adminer, and `afterUp` receives the services and their variables once they are healthy:

```ts
dev: {
  beforeCompose: (document) => ({ ...document, services: { ...document.services, adminer: { image: "adminer:4.8.1", ports: ["8080:8080"] } } }),
  afterUp: ({ services, env }) => console.log(`${services.length} services ready on ${env.DATABASE_URL}`),
},
```

## Level 5: override files

`dev/compose.override.yml` is passed to Docker Compose after the generated file, so it changes or adds services:

```yaml
services:
  adminer:
    image: adminer:4.8.1
    ports: ["8080:8080"]
```

## Level 6: replace the implementation

`runner` replaces every `docker compose` call, for the local services and the test containers; this one runs Podman:

```ts
import { dockerComposeRunner, spawnExec } from "@quickservicets/core";

dev: { runner: dockerComposeRunner(spawnExec, process.env, ["podman", "compose"]) },
```

## Level 7: eject

```bash
bun run quickservicets eject dev
```

It copies the native into `features/dev/`, where the project owns its options, hooks and `services` commands; the tests keep passing.
