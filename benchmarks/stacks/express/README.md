# express

The benchmark API ([`../../CONTRACT.md`](../../CONTRACT.md)) on Node.js with Express, in plain JavaScript (ES modules, nothing to compile).

| Piece | Version |
| --- | --- |
| Node.js | 24.21.0 LTS (`node:24.21.0-alpine3.24`) |
| Express | 5.2.1 |
| node-postgres (`pg`) | 8.23.1, pure JavaScript client, `pg.Pool` |
| busboy | 1.6.0 (multipart parser) |
| uuid | 14.0.2 (`v7()` for ids) |

## Two CPUs

`src/server.js` is a Node `cluster` primary that forks `WORKERS` (2) worker processes. They share port 8080 and the primary hands connections out round-robin, the cluster default on Linux. The primary serves no requests and restarts a worker that crashes. Each worker gets an equal share of the pool, `DB_POOL_SIZE / WORKERS` (5 + 5 = 10 connections in total). `SIGTERM` reaches the primary (PID 1), which stops the workers; each one closes its server and pool.

## Notable choices

- `NODE_ENV=production`. No request logging, which is Express's default (it ships no logger).
- `etag` and `x-powered-by` are turned off: the contract allows no HTTP caching headers, so no ETag is computed.
- Express 5's default `simple` query parser, so `where[age][gte]` arrives as a flat key and a repeated parameter arrives as an array (the `Parameter is repeated` error).
- `express.json({ strict: false })` with a `verify` hook that rejects an empty body. Without the hook, body-parser would turn an empty body into `{}`.
- Fixed queries are named prepared statements (`pg` prepares each one once per connection). List queries are built per request with bind parameters. The page and the `count(*)` run in parallel on two pool connections.
- Organization members come from one query per page (`owner_id = ANY($1)`), joined with `users` for `populate=members`. Stats are one SQL aggregate. `DELETE /users/{id}` is one statement: a CTE deletes the user and touches the organizations that listed it.
- Uploads: busboy streams the parts and the file is held in memory, up to the 1 MiB limit plus one byte. busboy flags a file as truncated once it reaches `fileSize`, so the limit is set to 1 MiB + 1 to accept exactly 1 MiB. `GET /media/{id}/file` streams from disk with `fs` and does not use `res.sendFile`, which would add `ETag`/`Last-Modified` caching headers.

## Known deviations

- busboy reports a file part that has no `Content-Type` header as `text/plain`, so such a part is treated as declared `text/plain` and not as "missing". Clients (browsers, Bun, k6) always send a type for file parts (`application/octet-stream` when they have no better one), so this does not happen in practice.

## Running on the host

```bash
npm ci
NODE_ENV=production PORT=8080 DATABASE_URL=postgres://bench:bench@localhost:55432/bench node src/server.js
```
