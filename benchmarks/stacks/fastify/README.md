# fastify

The benchmark API ([`../../CONTRACT.md`](../../CONTRACT.md)) on Node.js with Fastify and hand-written SQL.

| Component | Version |
| --- | --- |
| Node.js | 24.21.0 LTS (`node:24.21.0-alpine3.23`) |
| Fastify | 5.12.5 |
| pg (node-postgres, pure JavaScript driver) | 8.23.0 |
| @fastify/multipart | 10.1.2 |
| uuid (v7 ids) | 14.0.2 |

## Using 2 CPUs

[`src/server.js`](src/server.js) is a Node `cluster` primary that forks `WEB_CONCURRENCY` (2) workers, each running one Fastify instance; they share port 8080 through the cluster module's round-robin. Each worker's `pg.Pool` gets `DB_POOL_SIZE / workers` connections (5 + 5 = 10). The primary forks a new worker if one dies, and on `SIGTERM` it stops the workers, which close the server and the pool.

## Notable choices

- Fastify's production defaults: logging off (`logger: false` is the default), the default JSON body parser (with prototype-poisoning protection) and `fast-querystring`.
- Responses are serialized by `fast-json-stringify` from route response schemas. `fields` selection works with the same schemas because absent properties are skipped. `?populate=members` switches to a second compiled schema with `reply.compileSerializationSchema`.
- Request validation is hand-written ([`src/users.js`](src/users.js), [`src/query.js`](src/query.js)), not Ajv: the contract requires exact messages, all problems reported together, with one message per field.
- SQL: filters, sorting and paging run in PostgreSQL. A list runs the page query and `count(*)` in parallel. Organization member ids come from an `ARRAY(SELECT ... ORDER BY position)` subquery, and populated members from one join query for the whole page. Stats are one aggregate query. `DELETE /users/{id}` is a single statement with data-modifying CTEs (delete the user, touch its organizations), so it is atomic without an explicit transaction.
- Every query is a named (prepared) statement. Each distinct SQL text gets a name, capped at 500 texts per process.
- Uploads: `@fastify/multipart` with a 1 MiB `fileSize` limit and `throwFileSizeLimit: false`, so the type check (magic bytes) still runs before the size check, as the contract orders them. Non-multipart requests to `POST /media` are rejected in a `preParsing` hook before any body parser runs.

## Known differences from QuickService (not tested)

- A file part without a `Content-Type` header is treated as `text/plain` (busboy follows RFC 7578), whereas QuickService treats it as having no declared type. Clients such as browsers, Bun and k6 always send a type for files.
- A JSON body containing `__proto__` is rejected as `Invalid JSON body`, by Fastify's default prototype-poisoning protection.
- Only the filters the contract requires are supported (`email`, `role`, `age` on users and `slug` on organizations, with `eq`/`ne`/`in`/`nin`, plus `gt`/`gte`/`lt`/`lte` on `age`). Other operators get `Operator "..." is not allowed for this field`.

## Running on the host

```bash
npm ci
NODE_ENV=production PORT=8080 DATABASE_URL=postgres://bench:bench@localhost:55432/bench UPLOAD_DIR=./uploads node src/server.js
```
