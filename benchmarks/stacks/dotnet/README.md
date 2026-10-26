# .NET stack

ASP.NET Core Minimal APIs on Kestrel, with Npgsql and plain ADO.NET.

| | Version |
| --- | --- |
| .NET SDK (build) | `mcr.microsoft.com/dotnet/sdk:10.0.401` |
| ASP.NET Core runtime | `mcr.microsoft.com/dotnet/aspnet:10.0.12` (Ubuntu 24.04) |
| Npgsql | 10.0.3 |

## How it uses 2 CPUs

One process, the way ASP.NET Core runs in production: Kestrel and the thread pool size themselves from
`Environment.ProcessorCount`, which is 2 under `--cpus=2`, and server GC (the ASP.NET Core default, stated in the
project file) uses one heap per CPU. One `NpgsqlDataSource` pool of `DB_POOL_SIZE` (10) connections.

## Notable choices

- Release build, published with ReadyToRun code for the target architecture (about 270 ms from `docker start` to the
  first `200` on `/health`), dynamic PGO on (the default), invariant globalization.
- `WebApplication.CreateSlimBuilder`; handlers are plain `RequestDelegate`s. The logging configuration is the
  ASP.NET Core template's production default (`Microsoft.AspNetCore` at `Warning`), so there are no per-request logs.
- Records with field selection are written straight from the `NpgsqlDataReader` to a pooled `Utf8JsonWriter` buffer
  and sent with a `Content-Length`; the fixed-shape bodies (errors, health, stats) use System.Text.Json source
  generation. Request bodies are parsed with `JsonDocument`, so "missing", `null` and wrong types can be told apart.
- SQL: lists send the `count(*)` and the page in one `NpgsqlBatch` (one round trip). Organization member ids come
  from an `ARRAY(...)` subquery in the same select; `populate=members` joins the members and their users onto the
  page subquery and streams the rows in page and `position` order (one query for the page, no N+1). Stats are one
  aggregate. `DELETE /users/{id}` is one statement (a `DELETE ... RETURNING` CTE plus the organizations'
  `updated_at` update), so it is atomic without an explicit transaction.
- Npgsql performance settings from its documentation: automatic preparation (`Max Auto Prepare=64`) and
  `No Reset On Close` (the service never changes session state). GSS encryption negotiation is disabled.
- Uploads are streamed with `MultipartReader`; only the `file` part is buffered, at most 1 MiB + 1 bytes.
- Listens on `0.0.0.0:$PORT`; `SIGTERM` stops the host (5-second shutdown timeout).
- Filter operators implemented: `eq`, `ne`, `in`, `nin` on every scalar field, plus `gt`, `gte`, `lt`, `lte` on
  numbers and dates. The other QuickService.ts operators (`contains`, `startsWith`, `exists`, `isNull`, the reference
  array ones) answer `Operator "<op>" is not allowed for this field`. Nested `fields` paths are not supported.

## Running on the host

```bash
~/.dotnet/dotnet build -c Release benchmarks/stacks/dotnet
PORT=18107 DATABASE_URL=postgres://bench:bench@localhost:55432/bench UPLOAD_DIR=/tmp/uploads \
  ~/.dotnet/dotnet benchmarks/stacks/dotnet/bin/Release/net10.0/QsBench.dll
```
