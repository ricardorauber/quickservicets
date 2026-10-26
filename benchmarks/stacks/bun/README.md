# Plain Bun

The "ceiling" for QuickService.ts on the same runtime: the same API written directly on Bun, with no framework.

| | |
| --- | --- |
| Runtime | Bun 1.4.2 (`oven/bun:1.4.2-alpine`, the same image QuickService.ts runs on) |
| HTTP | `Bun.serve` with its `routes` table (static paths, `:param` segments, per-method handlers) |
| Database | the built-in `Bun.sql` PostgreSQL client (prepared statements, connection pool) |
| Dependencies | none |

## How it uses 2 CPUs

`src/launcher.ts` spawns `WORKERS` (default 2) processes of `src/server.ts`. Each one calls `Bun.serve` with `reusePort: true`, so the Linux kernel spreads connections across them (SO_REUSEPORT). The launcher splits `DB_POOL_SIZE` between the workers (10 → 5 + 5), forwards `SIGTERM`/`SIGINT` to them, and restarts a worker that dies unexpectedly.

## Notable choices

- Production build: `bun build --target=bun --production` bundles and minifies the launcher and the worker into `dist/`; the container runs `bun dist/launcher.js` with `NODE_ENV=production`. No request logging (Bun's default).
- SQL does the sorting, filtering, paging and counting. A list runs the page query and the `count(*)` query in parallel. Organization member ids come from an `array_agg(... ORDER BY position)` subquery in the page query; `populate=members` loads the members of the whole page with one join on `organizations__members`.
- `GET /organizations/{orgId}/stats` is one aggregate query (`count`, `count FILTER`, `avg`).
- `DELETE /users/{id}` is one statement (a data-modifying CTE): it deletes the user, the junction rows cascade, and the owning organizations get `updated_at = now` in the same implicit transaction.
- `POST /users` and `PATCH` detect a taken email from SQLSTATE `23505` on `users_email_uq`.
- Uploads use a small single-pass multipart parser instead of `Request.formData()`, because Bun's form parser derives a file part's type from its file name rather than the part's `Content-Type` header, which the upload rules depend on.
- A wrong method on a known path falls through to the `404 Route not found` handler (not tested by the contract).

## Running on the host

```bash
PORT=8080 DATABASE_URL=postgres://bench:bench@localhost:55432/bench bun src/launcher.ts
```

On macOS `reusePort` does not balance connections between the workers; it does in the Linux container.
