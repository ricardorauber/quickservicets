# FastAPI

The benchmark API ([`../../CONTRACT.md`](../../CONTRACT.md)) on Python with FastAPI, Pydantic and asyncpg.

| Component | Version |
| --- | --- |
| Python | 3.13.15 (`python:3.13.15-slim-trixie`) |
| FastAPI / Starlette | 0.142.2 / 1.7.0 |
| Pydantic / pydantic-core | 2.13.5 / 2.46.5 |
| asyncpg | 0.31.0 |
| uvicorn / uvloop / httptools | 0.54.0 / 0.22.1 / 0.8.0 |
| python-multipart | 0.0.32 |
| orjson | 3.12.0 |

Every dependency, transitive ones included, is pinned in [`requirements.txt`](requirements.txt).

## Using 2 CPUs

uvicorn runs **2 worker processes** (`--workers $WEB_CONCURRENCY`, `WEB_CONCURRENCY=2`) with the uvloop event loop and the httptools parser, the setup FastAPI's deployment docs recommend for containers. Each worker opens its own asyncpg pool of `DB_POOL_SIZE / WEB_CONCURRENCY` = 5 connections (min = max, opened at startup), so the container holds 10 connections in total.

## Notable choices

- **Responses** are rendered with orjson through a small `Response` subclass, and handlers return responses directly, so FastAPI's `jsonable_encoder` is skipped. Timestamps come from asyncpg as UTC datetimes and are formatted with `isoformat(timespec="milliseconds")`.
- **Request bodies** are parsed with orjson and validated with Pydantic models in strict mode (`extra="forbid"`). Pydantic's error types are translated into the contract's messages. A custom validator handles `age` (`30.0` is an integer, `"30"` is not a number), and another counts `name` in UTF-16 code units.
- **List queries** (`where`, `sort`, `limit`, `offset`, `fields`, `populate`) are parsed by hand from the raw query items, then compiled to parameterized SQL. The same operator set as QuickService is supported for column fields. `limit` and `offset` are bind parameters, so asyncpg's prepared-statement cache stays small. Each page costs one `SELECT` plus one `count(*)`. Organization member ids come from an `ARRAY(...)` subquery in the same `SELECT`. With `populate=members`, the members of the whole page are loaded in one join query.
- **Stats** are computed in a single SQL statement (`EXISTS` plus `count` / `FILTER` / `avg`).
- **DELETE /users/{id}** is one statement with data-modifying CTEs: it deletes the user and moves `updatedAt` on the owning organizations atomically. The junction rows are removed by the foreign key cascade.
- **Uploads** use Starlette's `request.form()` (python-multipart). Files are written and read in the thread pool.
- **Logging**: uvicorn's default access log (one line per request to stdout) is left on, as the production default.
- `/docs`, `/redoc` and `/openapi.json` are disabled, so unknown paths are always `404 Route not found`.

## Running locally

```bash
python3.13 -m venv .venv && .venv/bin/pip install --no-deps -r requirements.txt
DATABASE_URL=postgres://bench:bench@localhost:55432/bench WEB_CONCURRENCY=2 \
  .venv/bin/uvicorn app.main:app --port 8080 --workers 2 --loop uvloop --http httptools
```
