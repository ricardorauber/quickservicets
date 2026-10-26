# Where QuickService.ts spends its time

A CPU and SQL profile of the QuickService.ts benchmark service (`benchmarks/quickservicets`) under the k6 scenarios of this study, with what-if experiments that test each hypothesis, and a prioritized list of optimization opportunities for the framework.

Nothing in `packages/` was changed. The what-if experiments ran against a patched **copy** of `packages/core/src`, mounted over the image's copy; that patch is in [`whatif/core.diff`](whatif/core.diff), gated per experiment by a `QS_WHATIF` environment variable. With every experiment switched on, that copy still passes the conformance suite (104 of 104 tests).

Contents:

1. [Summary](#1-summary)
2. [Method](#2-method)
3. [Where the CPU goes](#3-where-the-cpu-goes)
4. [SQL statements per request](#4-sql-statements-per-request)
5. [What-if experiments](#5-what-if-experiments)
6. [Per-scenario findings](#6-per-scenario-findings)
7. [Prioritized opportunities](#7-prioritized-opportunities)
8. [Files](#8-files)

## 1. Summary

- **The app process is the bottleneck in every scenario except `list_users` and `filter_users`.** Those two are bound by PostgreSQL (`count(*)` plus an offset or sort scan), and QuickService.ts already matches Go there (2,007 and 1,046 req/s against Go's 1,792 and 959).
- **Five framework costs explain most of the gap to plain Bun.** In order of the CPU they take: Drizzle building SQL on every call (16–55% of sampled JS time), `structuredClone` in `project()` (10–43%), the synchronous stdout write of the per-request log line (75% on `health`, 4–14% elsewhere), extra SQL round trips (writes run 4–6 statements where 1 would do; `custom` runs 5 including two identical `count(*)`), and a single process on a 2-CPU container.
- **All of these were tested by experiment.** Combined, they bring one QuickService.ts process to between 40% and 95% of one plain-Bun process:

  | Scenario | QuickService.ts today | All what-ifs, 1 process | Plain Bun, 1 process | Plain Bun, 2 processes |
  | --- | ---: | ---: | ---: | ---: |
  | `get_user` | 8,813 | 19,289 | 20,622 | 30,891 |
  | `create_user` | 4,366 | 12,858–14,622 | 20,183 | 28,519 |
  | `custom` | 2,154 | 4,746–5,012 | 11,864 | 12,777 |
  | `populate_orgs` | 483 | 1,004–1,110 | 2,611 | 2,348 |
  | `upload` | 1,787 | 3,721–4,039 | 3,923 | 4,702 |

  All numbers are req/s on the same loaded machine, measured within about an hour of each other; the ranges are two repeated runs. Running two processes (reusePort) roughly doubles the CPU-bound scenarios again (section 7, P5).

## 2. Method

**Setup.** QuickService.ts ran from the `qsbench-quickservicets` image, which matches `packages/core/src` at the current commit (checked with `diff`). The container had `--cpus=2 --memory=1g`, ran one Bun process (the shipped setup), and used a private PostgreSQL 17.11 container. That database had the settings of [`docker-compose.yml`](../docker-compose.yml) plus `pg_stat_statements`, used the same schema and seed, and sat on the `qsbench` network. k6 (`grafana/k6:2.3.0`, 4 CPUs, 64 VUs) ran the scripts in [`load/`](../load/) on the same network. The shared `qsbench-postgres` was not touched, because another run was using it.

**CPU profiles.** The service ran as `bun --cpu-prof --cpu-prof-dir=/prof --cpu-prof-md .generated/server.ts`, with one container per scenario and 15 seconds of load. `docker stop` (SIGTERM) then wrote the profile. [`tools/analyze.py`](tools/analyze.py) drops the startup samples (the ones before the first request, plus module loading) and does two things:

- It assigns each sample to the **nearest framework frame** on its stack, so a native `write` called from `logger.ts` counts as logging, and a `structuredClone` called from `projection.ts` counts as projection. Node and Bun internal frames are skipped; `drizzle-orm` and Bun's `internal:sql` are categories of their own.
- It reports the self and inclusive time of each function.

[`tools/inclusive.py`](tools/inclusive.py) gives the inclusive share of named components.

**Limits of the profiles:**

- Bun's (JavaScriptCore's) sampler records only the JS thread. Native work that the event loop does outside JS calls, such as HTTP parsing, socket I/O and Postgres protocol decoding before the callback, shows as "native, no JS caller", or not at all.
- The machine was heavily loaded (load average around 20 on 10 cores), so the sampler ran at about 300–550 samples/s instead of 1,000.

For both reasons the shares are **proportions of sampled JS time**, not of total CPU. Every conclusion below was checked with a throughput experiment, because a profile share does not translate one to one into req/s. For example, removing the log line raised `health` by 40%, not by the 75% that its profile share suggests.

**SQL counts.** The counts come from `pg_stat_statements` with `track=all`, which also records statements run inside the foreign-key triggers:

1. reset the statistics;
2. run N requests of one kind, one at a time ([`tools/count-queries.k6.js`](tools/count-queries.k6.js), 1 VU, N = 200, or 100 for deleting organization members);
3. divide the calls by N.

**Throughput experiments.** Each run had 10 seconds of load, with no profiler, and was repeated twice in interleaved order. Because of the machine load, the absolute numbers are 10–40% below those in `results/quickservicets.json` and swing between repeats. Compare numbers within a block that was measured together, not across blocks.

## 3. Where the CPU goes

Share of sampled JS time by category (nearest framework frame), per scenario:

| Category | health | get_user | list_users | filter_users | populate_orgs | custom | create_user | upload |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| drizzle (SQL building, row mapping, session) | – | 28.2 | 16.0 | 20.5 | 21.3 | 45.2 | 55.0 | 36.5 |
| projection/selection (`structuredClone`) | – | 12.5 | 35.4 | 41.2 | 51.9 | 15.6 | – | 4.8 |
| request logging | 74.7 | 13.6 | 12.5 | 8.7 | 1.2 | 6.0 | 4.9 | 3.5 |
| native, no JS caller (event loop, I/O, GC) | – | 17.3 | 13.6 | 13.8 | 6.1 | 10.0 | 11.1 | 6.1 |
| Bun.sql driver (JS side) | – | 14.6 | 5.5 | 6.9 | 4.4 | 12.4 | 18.2 | 12.6 |
| http server (core: URL, Request/Response, headers) | 19.8 | 7.7 | 7.2 | 2.8 | 3.9 | 2.9 | 4.5 | 3.3 |
| multipart parsing + type detection | – | – | – | – | – | – | 0.1 | 20.4 |
| storage (`mkdir` + write) | – | – | – | – | – | – | – | 6.4 |
| JSON.stringify of the response | 0.6 | 2.6 | 6.4 | 1.2 | 4.1 | 0.4 | 1.8 | 1.6 |
| routing | 4.8 | 1.2 | 0.4 | 0.3 | 0.2 | 0.3 | 0.3 | 0.5 |
| populate + relations | – | 0.5 | 0.4 | 0.6 | 5.8 | 2.3 | 1.0 | 1.1 |
| list query parsing | – | – | 1.6 | 2.4 | 0.4 | – | – | – |
| fluent query (`fieldHandles` per call, etc.) | – | – | – | – | – | 2.9 | – | – |
| validation, repository, adapter, hooks | – | 0.9 | 0.6 | 1.2 | 0.6 | 1.6 | 2.7 | 2.0 |

Inclusive share of the main components:

| Inclusive % of sampled JS time | health | get_user | list_users | filter_users | populate_orgs | custom | create_user | upload |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| request logging (`safeLog`) | 74.7 | 13.6 | 12.5 | 8.7 | 1.2 | 6.0 | 4.9 | 3.5 |
| … of which the native stdout `write` | 70.7 | 12.6 | 11.7 | 8.1 | 1.1 | 5.6 | 4.3 | 3.1 |
| any Drizzle frame on the stack (including its calls into Bun.sql) | – | 33.3 | 18.0 | 22.8 | 22.9 | 50.0 | 61.3 | 39.9 |
| Drizzle SQL text build (`sqlToQuery`) | – | 18.2 | 6.2 | 8.1 | –¹ | 25.0 | –¹ | 16.8 |
| Bun.sql JS (`internal:sql`, `bun:sql`) | – | 14.6 | 5.5 | 6.9 | 4.4 | 12.4 | 19.4 | 13.9 |
| `project()`, including `structuredClone` | – | 12.2 | 35.2 | 40.1 | 51.8 | 15.6 | – | 4.8 |
| … `structuredClone` alone | – | 9.7 | 28.8 | 31.6 | 43.4 | 14.0 | 0.2 | 4.4 |
| `presentPopulated` (two projections per member) | – | – | – | – | 19.7 | – | – | – |
| JSON.stringify of the response (`toResponse`) | 4.0 | 7.4 | 11.9 | 2.4 | 7.4 | 1.8 | 4.5 | 3.1 |
| `router.match` (linear scan) | 4.8 | 1.2 | 0.4 | 0.3 | 0.2 | 0.3 | 0.3 | 0.5 |
| `readMultipart` (formData + second header scan + copies) | – | – | – | – | – | – | – | 15.8 |

¹ The JIT inlined `sqlToQuery` into its callers in these profiles; the "any Drizzle frame" row still counts them.

Top self-time functions, which show the same picture from the other side:

- `get_user`: native, no JS caller 17%, stdout `write` 13%, `structuredClone` 10%, Drizzle `mergeQueries` 4.5%, Drizzle `sql.js:82` 3.9%, `JSON.stringify` 3.2%.
- `populate_orgs`: `structuredClone` 43%, native 6%, `JSON.stringify` 4.2%, Drizzle `sql.js:82` 3.5%, Drizzle `prepareTyping` 2.9%, `mapResultRow` 2.5%, projection `keep` 2.5%.
- `create_user`: native 11%, Drizzle `sql.js:82` 8.9%, Drizzle `mergeQueries` 6.8%, `run` 4.9%, stdout `write` 4.3%. This is almost all Drizzle building `INSERT … RETURNING` and two `SELECT`s.

The startup profile also shows the MongoDB driver being loaded (about 15% of startup samples) although the service uses PostgreSQL. This affects startup time only.

## 4. SQL statements per request

Top-level statements the service sends per request. The "trigger" rows are statements PostgreSQL runs inside foreign-key triggers because of what the service sends.

| Request | Statements | What they are | Hand-written stacks |
| --- | ---: | --- | ---: |
| `GET /health` | 0 | | 0 |
| `GET /users/{id}` | 1 | `SELECT … WHERE id = $1 LIMIT $2` | 1 |
| `GET /organizations/{id}` | 2 | row + junction (`organizations__members`) | 1 (`array_agg` subquery) |
| `GET /users?limit=20&offset=n` | 2 | page + `count(*)` (4.6 ms of database time per request, DB-bound) | 2 |
| `filter_users` | 2 | filtered page + filtered `count(*)` (8.7 ms of database time, DB-bound) | 2 |
| `populate_orgs` | **5** | orgs page, `count(*)` of orgs, junction rows, users `IN (100 ids)`, **`count(*)` of users `IN (100 ids)`** (not needed) | 2–3 |
| `GET /organizations/{id}/stats` | **5** | org, junction, **`count(*)` users `IN`**, users `IN … ORDER BY`, **`count(*)` users `IN`** again | 1 (aggregate) |
| `POST /users` | **4** | `BEGIN`, `INSERT … RETURNING *`, `COMMIT`, **`SELECT` of the row just returned** | 1 |
| `POST /users`, email taken | 3 | `BEGIN`, failing `INSERT`, `ROLLBACK` | 1 |
| `PATCH /users/{id}` | **5** | `SELECT`, `BEGIN`, `UPDATE … RETURNING id`, `COMMIT`, `SELECT` | 1 |
| `DELETE /users/{id}` (not a member) | **6** | `SELECT`, `BEGIN`, `count(*)` of orgs referencing the user, `SELECT` user again, `DELETE`, `COMMIT` | 1 (CTE) |
| `DELETE /users/{id}` (member of one org) | **12 + 19 trigger** | the above plus `findMany` of the orgs (page + count + junction), `UPDATE organizations`, then **all 9 remaining junction rows deleted and re-inserted** (18 foreign-key checks) | 1 (CTE) |
| `POST /media` | 4 | `BEGIN`, `INSERT … RETURNING *`, `COMMIT`, `SELECT` | 1 |

Root causes in the code:

- `adapters/postgres.ts` wraps every `insert` and `updateById` in `transaction()`, even for an entity without reference arrays (one statement).
- `repository.ts` (`createRecord`, `write`) re-reads the record with `existing()` after the write, although `insert` already returns the row.
- `adapters/postgres.ts` `findMany` always runs `count(*)`. That count is needed for list pages, but it is also paid by `populateRecords`, `findByIds`, `findReferencing` and fluent `all()`.
- `fluent-query.ts` `all()` runs `count()` first to enforce `findAllMax`, then `list()`, which counts again.
- `referential-integrity.ts` `planDelete` plus `writeRelations` "pull" a member by rewriting the whole junction list of every owning organization.
- `sql/relations.ts` `loadRelations` loads reference arrays with a separate query instead of in the row's own `SELECT`.

## 5. What-if experiments

Each experiment is a switch in the patched copy ([`whatif/core.diff`](whatif/core.diff)) or a config file using the documented `logger` option ([`whatif/`](whatif/)). Results are req/s for two interleaved runs.

| Experiment | What it changes |
| --- | --- |
| `nolog` | `logger: { info() {}, warn() {}, error() {} }` in `quickservicets.config.ts` |
| `batchlog` | the same JSON lines, buffered and written once per event-loop turn (`setImmediate`) |
| `noclone` | `project()` skips `structuredClone` (`keep`/`remove` already build new objects along the selected paths) |
| `rawsql` | `findById` and `insert` (outside transactions) use precomputed SQL text with `client.unsafe(text, params)` instead of Drizzle |
| `notx` | no `BEGIN`/`COMMIT` around `insert`/`updateById` of entities without reference arrays |
| `noreselect` | `create` returns the row from `INSERT … RETURNING` instead of selecting it again |
| `nocount` | `findMany` skips `count(*)` when the caller does not need it (populate, fluent `all()`); `all()` asks for `findAllMax + 1` rows instead of counting first |

| Scenario | Baseline | Variant | Change |
| --- | ---: | ---: | ---: |
| `health` | 38,443 / 38,665 | `nolog` 54,249 / 54,085 | **+40%** |
| `health` | | `batchlog` 50,498 / 50,951 | **+31%** |
| `get_user` | 9,880 / 9,873 | `nolog` 11,174 / 11,163 | +13% |
| `get_user` | | `batchlog` 10,804 / 8,529 | +9% (2nd run noisy) |
| `get_user` | 9,925 / 6,236 | `noclone` 10,806 / 9,148 | +9% (1st pair) |
| `get_user` | | `rawsql` 15,081 / 13,295 | **+52%** (1st pair) |
| `get_user` | | `noclone,rawsql,nolog` 19,289 / 12,939 | **+94%** (1st pair) |
| `create_user` | 4,336 / 1,576 | `notx` 5,561 / 2,911 | +28% (1st pair) |
| `create_user` | | `notx,noreselect` 9,383 / 5,014 | **+116%** (1st pair) |
| `create_user` | | `notx,noreselect,rawsql` 12,858 / 12,823 | **+197%** (1st pair) |
| `create_user` | | `…,noclone,nolog` 14,622 / 11,328 | +237% (1st pair) |
| `custom` | 2,208 / 2,348 | `nocount` 3,025 / 3,009 | **+33%** |
| `custom` | | `noclone` 2,452 / 2,679 | +11% |
| `custom` | | `nocount,noclone,rawsql` 3,463 / 4,379 | +57% / +86% |
| `custom` | | `…,nolog` 4,746 / 5,012 | **+114%** |
| `populate_orgs` | 503 / 529 | `noclone` 889 / 949 | **+78%** |
| `populate_orgs` | | `nocount` 536 / 583 | +8% |
| `populate_orgs` | | `noclone,nocount,rawsql,nolog` 1,004 / 1,110 | **+105%** |
| `upload` | 1,954 / 1,745 | `notx,noreselect` 2,109 / 2,802 | +8% / +61% (noisy) |
| `upload` | | `notx,noreselect,rawsql,noclone,nolog` 3,721 / 4,039 | **+90% / +131%** |

The second `create_user` baseline (1,576) and the second `get_user` baseline (6,236) fell during load spikes from the other session; the changes above use the first pair. The second pair points the same way.

**Same-window ceilings** (10 seconds each, back to back; plain Bun is `benchmarks/stacks/bun` with `WORKERS=1` and `WORKERS=2`):

| req/s | QuickService.ts | plain Bun, 1 process | plain Bun, 2 processes | QuickService.ts as % of 1-process Bun |
| --- | ---: | ---: | ---: | ---: |
| `health` | 33,456 | 51,346 | 47,652 | 65% |
| `get_user` | 8,813 | 20,622 | 30,891 | 43% |
| `custom` | 2,154 | 11,864 | 12,777 | 18% |
| `create_user` | 4,366 | 20,183 | 28,519 | 22% |
| `populate_orgs` | 483 | 2,611 | 2,348 | 18% |
| `upload` | 1,787 | 3,923 | 4,702 | 46% |

With every what-if switched on, one QuickService.ts process reaches about 94% of one plain-Bun process on `get_user`, 64–72% on `create_user`, about 100% on `upload`, 40–42% on `custom` and 38–43% on `populate_orgs`. The remaining gap on those two is shown by the what-if profiles in [`profiles/`](profiles/):

- **Drizzle is still 37% (`populate_orgs`) and 57% (`custom`) of sampled time**, because `findMany`, `count` and the junction query still go through it.
- **Round trips:** 3–4 statements against plain Bun's 1–2.

## 6. Per-scenario findings

- **`health`**: 0 queries. With nothing else to do, 75% of sampled JS time is the synchronous `process.stdout.write` of the log line (stdout is a pipe in Docker, one write syscall per request). The rest is the core server (`new URL`, `Response`, `Headers`, the `x-request-id` header, `randomUUIDv7`) at 20% and the linear router at 5%. Without logging: +40%, which reaches the plain-Bun level (54k against 51k in a similar window).
- **`get_user`**: 1 query, so the per-request overhead is the framework's. Drizzle building `select … where id = $1` costs 28%, Bun.sql's JS side 15%, logging 14%, and `structuredClone` in `selectFields` 12.5% (the exposure is applied with a deep clone, even with no `fields` parameter). The `rawsql` what-if alone gives +52%.
- **`list_users` / `filter_users`**: DB-bound (`count(*)` and the offset or sort scan; QuickService.ts equals Go). The app side is still dominated by projection (35–41%, a clone per row and per projection step). That matters at 2 processes, or when the database is faster.
- **`populate_orgs`**: 5 queries, app CPU-bound with PostgreSQL mostly idle. `structuredClone` alone is 43% of sampled JS time:
  - `presentPopulated` projects each of the 100 members twice (hidden fields, then the read exposure), each time with a deep clone;
  - `selectFields` then clones each organization again, now with its 10 nested users.

  Drizzle is 21%. `noclone` alone: +78%.
- **`custom`** (stats): 5 queries, two of them identical `count(*)`. Drizzle is 45%, with `select().from().where(inArray(...))` rebuilt three times; projection 16% (`.select("role", "age")` clones each row); Bun.sql 12%. `fieldHandles` rebuilds every field handle for each `where` lambda call (1.7%). `nocount`: +33%; everything: +114%. Plain Bun does one aggregate query and is 5.5 times faster in the same window.
- **`create_user`**: 4 statements. Drizzle is 55% (building the `INSERT … RETURNING` and two `SELECT`s, plus the transaction wrapper); validation is under 1%. `notx` plus `noreselect` doubles throughput; adding `rawsql` triples it.
- **`upload`**: 4 statements. Drizzle is 36%; multipart 20%:
  - `formData()` 5.4%;
  - `declaredFileTypes` 4.4%, a second scan of the whole body to recover each part's `Content-Type`;
  - copies: body to `Buffer` to `Response.formData()` to a new `File` per part.

  Storage is 6% (`mkdir` per object directory, then the write). Throughput doubles with the database and logging what-ifs, so multipart is not the first thing to fix. The 2-process image barely helps `upload` (2,437 to 2,532), which points at per-request I/O (file write and `mkdir` on the Docker volume) as the next limit.
- **Writes in `crud`**: `PATCH` runs 5 statements and `DELETE` 6. Deleting a member costs 12 statements plus 19 trigger statements, because the "pull" rewrites the whole junction list of the organization.

## 7. Prioritized opportunities

Ordered by expected gain per unit of effort. Gains are for one process unless stated; the "ceiling" is plain Bun with one process measured in the same window.

### P1. One statement per simple write (create, update, delete)

- **Evidence:** create runs 4 statements, patch 5, delete 6, and deleting a member 12 + 19 (section 4). `notx` gave +28%; `notx` plus `noreselect` gave +116% on `create_user` and +8–61% on `upload`.
- **Change:**
  - Run `insert`/`updateById` without `transaction()` when the entity has no reference arrays, derived fields or `@onConflict replace` (the repository already knows this through `syncsRelations`).
  - Return the `RETURNING *` row instead of re-selecting it: `adapter.updateById` should return the row, not a boolean.
  - Make `PATCH` a single `UPDATE … RETURNING *`; a zero-row result means 404, after body validation, so the contract order is kept.
  - Make the delete "pull" a `DELETE FROM junction WHERE target_id = $1 RETURNING owner_id` plus one `UPDATE … SET updated_at` for the owners, instead of rewriting each list. Skip the second `findById` and the duplicate `planDelete` count when no file cleanup applies.
- **Expected gain:** `create_user` about 2x (measured), `PATCH` and `DELETE` similar (5 or 6 round trips down to 1 or 2), `crud` about +40–60%. The database also does less work under the shared pool of 10 connections.
- **Effort:** low for create and update (adapter and repository internals); medium for delete (the delete plan stays the source of truth, only its execution changes).
- **Risk to simplicity and DX:** none visible to users. The adapter contract tests in `testing/adapter-contract.ts` cover the behavior. Unique-violation mapping already works without a transaction, as the `rawsql` and `notx` what-ifs showed.

### P2. Stop deep-cloning in projections

- **Evidence:** `structuredClone` takes 10–43% of sampled JS time. `noclone` gave +78% on `populate_orgs`, +11% on `custom` and +9% on `get_user`.
- **Change:**
  - Drop the `structuredClone` in `project()`: `keep` builds new objects along the kept paths, and `remove` copies each level it changes.
  - Add a fast path in `selectFields` and `presentPopulated` when the exposure is "every field" and there is no client selection.
  - In `presentPopulated`, apply the hidden-field exclusion and the read exposure in one pass.
- **Expected gain:** +75–80% on populate (measured), +10–30% on lists at 2 processes, and +9% on single reads.
- **Effort:** low (one file plus tests).
- **Risk:** low. Results share leaf values (dates, arrays) with the loaded records, but those records are created per request. Document that post-hooks may mutate the result they receive, and keep a copy only where a cached value could leak (none today).

### P3. Buffered request logging

- **Evidence:** the stdout `write` is 75% of sampled time on `health` and 13% on `get_user`. Turning logging off gave +40% and +13%; the same lines written once per event-loop turn gave +31% and +9%.
- **Change:** keep the default JSON line per request, but have `jsonLogger` append to a buffer and flush it with one write per tick, or when the buffer passes about 64 KB. Also flush synchronously on `exit` and in `shutdown`, so lines survive a graceful stop. For example, use `Bun.stdout.writer()` with explicit `flush()`, or a string buffer.
- **Expected gain:** +30% on the framework floor and about +10% on single-query routes. Less on heavier routes (populate +1%).
- **Effort:** low.
- **Risk:** low. The output and its order are unchanged; a hard crash can lose the last tick of lines (at most a few ms). Existing log tests that read stdout synchronously would need to await a flush.

### P4. Do not count when nobody reads the total

- **Evidence:** `custom` runs two identical `count(*)` statements and `populate_orgs` one unneeded count. `nocount` gave +33% on `custom` and +8% on `populate_orgs`.
- **Change:**
  - Give `adapter.findMany` an internal `withTotal: false` option and use it from `populateRecords`, `findByIds`, `findReferencing` and `assertReferencesExist`.
  - Make fluent `all()` fetch `findAllMax + 1` rows instead of counting first; it still throws when there are too many.
  - For list pages, run the page and the count concurrently, as plain Bun does. This lowers latency, not database work.
- **Expected gain:** +30% on fluent-query endpoints, +5–10% on populate, and fewer statements on deletes.
- **Effort:** low.
- **Risk:** none for users. The `findAllMax` error message changes from "matched N records" to "matched more than findAllMax".

### P5. Multi-core: reusePort workers

- **Evidence:** the experimental 2-process image (`Dockerfile.2proc`, since replaced by `Dockerfile.workers` and `server.workers`: `reusePort: true` and 5 connections per process) measured these req/s:

  | Scenario | 1 process | 2 processes | Change |
  | --- | ---: | ---: | ---: |
  | `health` | 42,040 | 60,969 | +45% |
  | `get_user` | 10,644 | 19,903 | +87% |
  | `custom` | 2,561 | 4,711 | +84% |
  | `populate_orgs` | 533 | 1,031 | +93% |
  | `create_user` | 5,141 | 8,478 | +65% |
  | `crud` | 3,791 | 4,917 | +30% |
  | `query` | 901 | 1,439 | +60% |
  | `upload` | 2,437 | 2,532 | +4% |
  | `list_users` / `filter_users` | | | ±0 (DB-bound) |

- **Change:**
  - A `server.workers` option (default `1`, or `"auto"` for the container's CPU count) that makes `quickservicets start` spawn N processes with `reusePort`.
  - The database pool split across the workers.
  - Signals forwarded to the workers, and a crashed worker restarted.
  - The job scheduler, run cleanup and abandoned-run monitor started in worker 0 only (run claiming is in the database, but the timers would otherwise run N times).
- **Expected gain:** up to about 1.9x on CPU-bound routes on 2 CPUs, multiplicative with P1–P4 and P6.
- **Effort:** low to medium (launcher plus scheduler election).
- **Risk:** medium.
  - Linux-only balancing: on macOS `reusePort` does not spread connections, so the development default must stay at 1.
  - It does not work with the memory and SQLite adapters, which hold state per process.
  - Per-process state in user code (module-level caches) silently diverges.
  - Logs from N processes interleave (each line is still whole).

  An opt-in option keeps the default experience unchanged.

### P6. Precompiled SQL instead of Drizzle on the hot paths

- **Evidence:** Drizzle frames are on the stack in 18–61% of sampled JS time. Most of it is rebuilding the same SQL text and query-builder objects on every call (`buildQueryFromSourceParams`, `mergeQueries`, `escapeName`, `prepareTyping`). `rawsql` (precomputed text, `client.unsafe(text, params)`) gave +52% on `get_user`, and +37% on `create_user` on top of P1. Even with every other what-if on, Drizzle is still 37–57% in `populate_orgs` and `custom`.
- **Change:**
  - In the PostgreSQL adapter, build the SQL text once per entity and statement shape (`findById`, `insert` by column set, update by id, junction load, count), with column aliases for the field names.
  - For `findMany`/`count`, compile `Condition[]` and the sort to text plus parameters with a small dedicated translator, cached by shape (fields, operators and sort, without the values).
  - Bun.sql then reuses its prepared statements for identical text.
  - Drizzle can stay for schema building and migrations.
  - A cheaper first step: cache Drizzle's built `{ sql, params }` per shape, or use Drizzle's `.prepare()` with placeholders for `findById` and `insert`.
- **Expected gain:** +40–55% on single-row reads (measured), +30–40% on creates, and probably +30–60% on populate and fluent endpoints once `findMany` is covered (their remaining Drizzle share). With P1–P4 this brings `get_user` to the 1-process ceiling (19.3k against 20.6k measured).
- **Effort:** medium (one to two weeks with the adapter contract suite; filters, `in` lists, reference-array operators and `ilike` need care).
- **Risk:** no DX change (Drizzle was never visible to users), but it is more framework code to maintain, plus a type-mapping risk (timestamps, `jsonb`, booleans) that the contract tests must cover. The SQLite adapter would either keep Drizzle or get the same treatment.

### P7. Fewer round trips for reference arrays and aggregates

- **Evidence:** every organization read costs a second statement for its junction rows. The stats endpoint needs 5 statements (3 after P4) where plain Bun uses 1 aggregate; with every what-if on, `custom` is still at 40% of the ceiling.
- **Change:**
  - Load reference arrays in the row's own `SELECT` with `coalesce((select array_agg(target_id order by position) from junction where owner_id = t.id), '{}')`, for `findById`, `findMany` and the populate parents.
  - Add a small aggregate API to fluent queries, for example `.count()`, `.sum(f)`, `.avg(f)` and `.countWhere(lambda)`, or a single `.aggregate({ members: count(), admins: count(u => u.role.eq("admin")), averageAge: avg("age") })`. The stats endpoint then becomes one query on the junction-joined users, and needs no organization row besides the 404 check.
- **Expected gain:** −1 statement for each read of an entity with reference arrays (about +15–25% on `GET /organizations/{id}`); the `custom` endpoint written with aggregates would approach plain Bun (likely 2–3x after P1–P6).
- **Effort:** medium; the aggregate API is new public surface.
- **Risk:** the `array_agg` change is internal. The aggregate API adds concepts to learn, but stays in the existing typed lambda style.

### P8. Single-pass multipart parsing

- **Evidence:** `readMultipart` is 15.8% of sampled time in `upload`: `formData()` plus a second full scan for part headers plus three copies of the body.
- **Change:** one parser that reads part headers (including `Content-Type`) and slices file bodies without copying, as `benchmarks/stacks/bun` does; or scan only the header blocks after `formData()`, and skip the `new File([file])` copies when the declared type already matches.
- **Expected gain:** +10–15% on uploads, and less memory per request.
- **Effort:** medium (multipart edge cases: quoted boundaries, `filename*`, preamble).
- **Risk:** low, behind the existing upload tests.

### P9. Small per-request costs

- **Router:** `match` filters every route with `filter`, `every` and `reduce` (4.8% of `health`). Index the routes by segment count and first static segment, or use `Bun.serve({ routes })`. Gain: about +3–5% on `health`. Effort: low.
- **Fluent queries:** `fieldHandles` rebuilds every field handle on each `where()` call (1.7% of `custom`); cache it per model.
- **Log entry:** it builds `new Date().toISOString()` and an object spread per line. This is minor once P3 is in.
- **Startup:** the PostgreSQL service loads the MongoDB driver at startup (about 15% of startup samples). Import adapters lazily for faster cold starts.

### Expected combined effect

P1 to P4 are small, internal and low-risk changes. Together, measured as `notx,noreselect,noclone,nocount,nolog` minus `rawsql`, they should give about 2x on `create_user`, `populate_orgs` and `custom`, and +20–40% on `get_user` and `health`. Adding P6 brings single-row reads to plain-Bun parity on one process. P5 then nearly doubles the CPU-bound scenarios again on the 2-CPU container. On `get_user` that is roughly 35–38k req/s, the 2-process plain-Bun level (30.9k in the same window, about 35.6k in quieter runs).

## 8. Files

| Path | What it is |
| --- | --- |
| [`profiles/<scenario>.cpuprofile`](profiles/) | Raw Bun CPU profiles (15 s of 64-VU load, baseline image). They open in Chrome DevTools (Performance, load profile) or speedscope |
| `profiles/custom.whatif-all.cpuprofile`, `profiles/populate_orgs.whatif-all.cpuprofile` | The same scenarios with every what-if switched on |
| [`tools/analyze.py`](tools/analyze.py) | Categories, top self and top inclusive functions: `python3 tools/analyze.py profiles/get_user.cpuprofile` |
| [`tools/inclusive.py`](tools/inclusive.py) | The inclusive component table: `python3 tools/inclusive.py get_user=profiles/get_user.cpuprofile …` |
| [`tools/count-queries.k6.js`](tools/count-queries.k6.js) | One-VU, fixed-iteration driver used with `pg_stat_statements` (`OP=get_user N=200`, mount `benchmarks/load` at `/load`) |
| [`whatif/core.diff`](whatif/core.diff) | The what-if patch, applied to a copy of `packages/core/src` only, gated by `QS_WHATIF` |
| [`whatif/config-nolog.ts`](whatif/config-nolog.ts), [`whatif/config-batchlog.ts`](whatif/config-batchlog.ts) | The logging experiments, using the documented `logger` option |
