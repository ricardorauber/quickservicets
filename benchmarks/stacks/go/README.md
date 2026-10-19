# Go stack

The benchmark API of [`../../CONTRACT.md`](../../CONTRACT.md) written by hand in Go with the standard library.

| | |
| --- | --- |
| Language | Go 1.27.1 (`golang:1.27.1-alpine3.24` builder; `go.mod` requires 1.25+) |
| HTTP | `net/http` with `ServeMux` method and path patterns (`GET /users/{id}`), no framework |
| Database | [pgx](https://github.com/jackc/pgx) v5.11.0 `pgxpool`, `MaxConns` = `DB_POOL_SIZE` (10) |
| Ids | `github.com/google/uuid` v1.6.0 `NewV7` |
| Image | static binary (`CGO_ENABLED=0`, `-trimpath -ldflags="-s -w"`) on `scratch`, running as uid 65532 |

## Using 2 CPUs

One process. Since Go 1.25 the runtime sets `GOMAXPROCS` from the container's CPU quota, so with `--cpus=2` it runs
goroutines on 2 OS threads; `net/http` serves every connection on its own goroutine. Nothing is tuned beyond the
defaults (`GOGC`, `GOMAXPROCS` and the pool are as shipped, apart from the pool size).

## Notable choices

- **Queries.** Plain SQL built from the validated query, with placeholders for every value (including `LIMIT` and
  `OFFSET`), so pgx's default statement cache prepares each query shape once per connection. A list sends the
  `count(*)` and the page query in one `pgx.Batch` (one round trip). Organization member ids come from an
  `ARRAY(SELECT target_id ... ORDER BY position)` subquery in the same row; `populate=members` loads all users of the
  page with one `id = ANY($1)` query. Stats are one `LEFT JOIN` + `GROUP BY` with `count`, `count FILTER` and `avg`.
  Member ids are not loaded when `fields` leaves out `members`.
- **Delete.** One statement: a data-modifying CTE deletes the user and sets `updated_at` on the organizations that
  listed it (both see the pre-statement snapshot); the foreign key cascades the junction rows.
- **Conflicts.** `409` comes from the unique index (SQLSTATE `23505`), never a check-then-insert.
- **JSON.** Request bodies are parsed with `encoding/json` (`map[string]json.RawMessage`, so types and `null` can be
  told apart per field). Responses are written with small append-style encoders into pooled buffers, since the
  records are flat and `fields` makes the shape dynamic.
- **Uploads.** `mime/multipart` streaming reader; the `file` part is buffered up to 1 MiB + 1 byte, then the checks
  run in the contract's order, the file is written under `UPLOAD_DIR` and the row inserted (the file is removed if
  the insert fails).
- **Logging.** None per request (`net/http`'s default); unexpected errors go to stderr.
- **Shutdown.** `SIGTERM` triggers `http.Server.Shutdown` with an 8-second deadline, then the pool closes.

Filters: every column field takes `eq`, `ne`, `in`, `nin`, `exists`, `isNull`; numbers and dates also `gt`, `gte`,
`lt`, `lte`; strings also `contains` and `startsWith`. Filters on `members`, nested `fields` paths and the `exclude`
parameter (optional in the contract) are not implemented.

## Running on the host

```bash
cd benchmarks/stacks/go
go build -o server .
PORT=8080 DATABASE_URL=postgres://bench:bench@localhost:55432/bench UPLOAD_DIR=uploads ./server
```

Without `DATABASE_URL`, the URL is built from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`.
