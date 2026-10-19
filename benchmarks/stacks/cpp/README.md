# cpp: C++20 with Drogon

The benchmark API ([`CONTRACT.md`](../../CONTRACT.md)) in C++20 on [Drogon](https://github.com/drogonframework/drogon), with Drogon's asynchronous PostgreSQL client and C++20 coroutine handlers (`drogon::Task<HttpResponsePtr>`).

| Piece | Version |
| --- | --- |
| Drogon | v1.9.13 (commit `4c54307`), built from source in the builder stage, static library |
| Trantor | the commit Drogon v1.9.13 pins as its submodule |
| Compiler | GCC 14.2 (Debian trixie), `-std=c++20`, CMake `Release` (`-O3 -DNDEBUG`) |
| JSON | jsoncpp 1.9.6 (Drogon's JSON library) |
| PostgreSQL client | libpq 17 (Debian trixie), through `drogon::orm::DbClient` |
| Base image | `debian:trixie-20260918-slim` (builder and runtime) |

## How it uses 2 CPUs

- Drogon is multi-threaded: `setThreadNum(2)` gives one HTTP event loop per CPU (set explicitly, because `hardware_concurrency()` reports the host's CPUs, not the container's `--cpus=2` quota).
- The database is one shared `DbClient` with exactly `DB_POOL_SIZE` = 10 connections. Drogon's "fast" (per-IO-thread) client was considered, but Drogon also creates one for the main loop, which would open 15 connections for 2 IO threads; the shared client keeps the total at 10. Its connections run on Drogon's own `DbLoop` threads (Drogon's default).
- libpq pipeline (batch) mode is on, as Drogon builds it by default with libpq 14 or later; `auto_batch` stays off, so each statement is its own implicit transaction.

## Notable choices

- **SQL.** Statements are prepared and cached per connection by Drogon. Filters, sorting and paging are in SQL. A list is two statements (page, then `count(*)` with the same filters). Organization member ids come from an `ARRAY(...)` subquery in the page query; `populate=members` loads the members of the whole page with one join query (`owner_id = ANY($1)`). Stats are one aggregate query. `DELETE /users/{id}` is one statement (a data-modifying CTE), so the delete and the `updatedAt` change of the owning organizations are atomic.
- **Unique email.** Drogon's libpq connections report server errors as a plain `drogon::orm::Failure` carrying the server message but not the SQLSTATE, so a `409` is recognized by the violated index name `"users_email_uq"` in that message (a `SqlError` with SQLSTATE `23505` is also accepted). There is no check-then-insert. Drogon logs these errors at `ERROR` level.
- **Timestamps.** The connections set `TimeZone=UTC`, and `timestamptz` text (`2026-01-01 00:00:00.6+00`) becomes ISO 8601 with milliseconds in C++.
- **Multipart.** `POST /media` uses a small RFC 7578 parser over the in-memory body, because Drogon's `MultiPartParser` turns each part's `Content-Type` into an enum (the contract's messages need the declared type as sent) and rejects parts with an empty file name. Bodies up to 8 MiB are accepted and kept in memory (`client_max_memory_body_size`), so uploads never spill to temporary files. The file is written with `fopen`/`fwrite` on the request's thread, no `fsync`.
- **Routes.** `registerHandler` routes; unknown paths go to a default handler that answers the JSON `404`. Static file serving is disabled (`setFileTypes({})`). Uncaught exceptions answer the JSON `500`.
- **Logging.** Drogon's production default: no per-request log, `INFO` level for its own messages.
- **Runtime image.** Debian slim with `libjsoncpp26` and `libpq5`, the stripped binary, running as `nobody`. `/data/uploads` exists in the image owned by `nobody`, so a fresh Docker volume mounted there is writable.
- **Stop.** Drogon handles `SIGTERM` and exits.

## Running locally

Drogon is not needed on the host; build and run the image:

```bash
docker build -t qsbench-cpp benchmarks/stacks/cpp
docker run --rm --network qsbench -p 127.0.0.1:8080:8080 -e DATABASE_URL=postgres://bench:bench@qsbench-postgres:5432/bench qsbench-cpp
```

Environment: `PORT` (8080), `DATABASE_URL` (or `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), `DB_POOL_SIZE` (10), `UPLOAD_DIR` (`/data/uploads` in the run), and `IO_THREADS` (2).
