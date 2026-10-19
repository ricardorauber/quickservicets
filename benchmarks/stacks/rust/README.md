# Rust (axum + tokio + tokio-postgres)

| | |
| --- | --- |
| Language | Rust 1.98.1 (image `rust:1.98.1-slim-trixie`; the crates resolve for Rust 1.88+) |
| HTTP | axum 0.8.9 on hyper 1.12 (HTTP/1.1 only), tokio 1.54 |
| Database | tokio-postgres 0.7.18 with a deadpool-postgres 0.14.2 pool of `DB_POOL_SIZE` (10) connections |
| JSON | serde 1, serde_json 1 |
| Runtime image | `gcr.io/distroless/cc-debian13:nonroot` (pinned by digest): glibc, libgcc, no shell |

## Using 2 CPUs

One process with tokio's multi-threaded runtime (`#[tokio::main]`). Its default worker count is
`std::thread::available_parallelism()`, which on Linux reads the cgroup CPU quota, so `--cpus=2` gives 2 worker
threads. The 10 pooled connections are shared by both threads.

## Notable choices

- Release profile: `opt-level = 3`, fat LTO, `codegen-units = 1`, stripped binary. Panics unwind (a panicking
  request does not take the process down).
- Every statement goes through deadpool's per-connection prepared-statement cache (`prepare_cached`). Dynamic list
  queries are cached by their SQL text, which only varies with the shape of the query (filters, sort, page).
- List routes send the page query and the `count(*)` query together on one connection (tokio-postgres pipelining).
  Organization member ids come from an `ARRAY(SELECT ... ORDER BY position)` column of the page query;
  `populate=members` loads the members of the whole page with one `= ANY($1)` join, and `GET /organizations/{id}`
  pipelines the record and its members.
- `DELETE /users/{id}` is one statement: a data-modifying CTE deletes the user and moves `updated_at` of its
  organizations; the junction rows cascade through the foreign key.
- Stats are one aggregate query (`count`, `count FILTER`, `avg`).
- Uploads are streamed part by part with axum's `Multipart` (multer); at most 1 MiB + 1 byte of the file is kept.
  Request bodies are capped by axum's default 2 MB limit.
- Filters: `id`, `email`, `name` and `slug` take `eq`, `ne`, `in`, `nin`; `role` the same with enum checking; `age`
  also takes `gt`, `gte`, `lt`, `lte`. `createdAt`/`updatedAt` are sortable but not filterable.
- `TCP_NODELAY` on accepted sockets. No request logging (axum has none by default); database and file errors are
  written to stderr.
- Graceful shutdown on `SIGTERM`.

## Running on the host

```bash
cargo build --release
PORT=8080 DATABASE_URL=postgres://bench:bench@localhost:55432/bench UPLOAD_DIR=uploads ./target/release/qsbench-rust
```
