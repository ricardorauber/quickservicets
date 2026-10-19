# PHP: Laravel 12 on Octane + Swoole

| | |
| --- | --- |
| Language | PHP 8.4.26 (`php:8.4.26-cli-alpine3.23`), OPcache with the tracing JIT |
| Framework | Laravel 12.69.3, query builder (no Eloquent) |
| Server | Laravel Octane 2.20.0 on Swoole 6.2.3 |
| Database | `pdo_pgsql`, one persistent connection per worker |
| Image | multi-stage: `composer:2.10.2` installs the production packages, the runtime is the PHP CLI image with Swoole, `pdo_pgsql`, `pcntl` and OPcache (about 160 MB) |

## How it uses 2 CPUs

Octane boots the Laravel application once per Swoole worker and keeps it in memory between requests. It runs
**10 request workers** (`OCTANE_WORKERS=10`) and no task workers. Each worker handles one request at a time and keeps
its own database connection open across requests, so the service holds **10 PostgreSQL connections** in total, the same
as every other stack (`DB_POOL_SIZE` is not used: a synchronous PHP worker can only use one connection at a time). With
one worker per CPU the workers mostly wait on the database (about 109% CPU and 1,470 req/s on `GET /users/{id}` with 2
workers, against about 199% and 2,540 req/s with 4), so the measured run uses the PHP norm of more workers than CPUs. Workers are recycled
after 10,000 requests (`OCTANE_MAX_REQUESTS`; Octane's default of 500 would re-bootstrap Laravel several times a second
under load).

## Notable choices

- **Lean HTTP stack.** The routes are in `routes/api.php` with no `/api` prefix, and the global middleware is reduced to
  `InvokeDeferredCallbacks` (no CORS, maintenance check, `TrimStrings` or `ConvertEmptyStringsToNull`). The routes
  and events are cached at build time (`route:cache` gives Symfony's compiled URL matcher). The configuration is
  read from the environment when each worker boots.
- **One round trip per query.** `Pdo\Pgsql::ATTR_DISABLE_PREPARES` sends each statement with its parameters through
  `PQexecParams`, instead of a named server-side prepare, execute and deallocate per statement.
- **Raw query string.** PHP's own parsing keeps only the last of repeated keys and nests `where[...]`, so
  `App\Support\ListQuery` reads `QUERY_STRING` itself; filters, sorting and paging become query builder calls. Lists
  run a `count(*)` and the page query; members (ids or populated users) load with one query per page.
- **Validation** is hand-written (`App\Support\UserInput`) for the contract's exact rules and messages; the JSON body
  is decoded once from the raw content. Unique emails are detected from `UniqueConstraintViolationException`.
- **PATCH** is one `UPDATE ... RETURNING`; **DELETE** is a transaction that touches the owning organizations, then
  deletes the user (the junction rows cascade). **Stats** is one aggregate query.
- **Uploads**: Swoole parses the multipart body; the file is moved from Swoole's temporary file to `UPLOAD_DIR`, and
  `GET /media/{id}/file` is a `BinaryFileResponse`, which Octane sends with Swoole's `sendfile`.
- **Production settings**: `APP_ENV=production`, `APP_DEBUG=false`, logs to stderr (Octane logs no request lines
  outside `local`), Swoole HTTP compression off, Octane's static-file lookup off, no `APP_KEY` (nothing is
  encrypted, so the encrypter is not warmed).

## Running locally

PHP is not needed on the host:

```bash
docker build -t qsbench-php benchmarks/stacks/php
docker run --rm --network qsbench -p 18109:8080 \
  -e DATABASE_URL=postgres://bench:bench@qsbench-postgres:5432/bench qsbench-php
```
