# Where QuickService.ts spends its time, round 2

A second CPU and SQL profile of the QuickService.ts benchmark service (`benchmarks/quickservicets`), after the twelve framework changes that followed [round 1](quickservicets-profile.md). It covers the four scenarios where QuickService.ts still trails the hand-written stacks: `create_user`, `upload`, `custom` and `get_user`. Each hypothesis was tested with a what-if experiment, and the result is a short list of confirmed opportunities plus the hypotheses that the measurements rejected.

As in round 1, nothing in `packages/` was changed. The experiments ran against a patched **copy** of `packages/core/src`, mounted over the image's copy and gated per experiment by `QS_WHATIF`; the patch is [`whatif-2/core.diff`](whatif-2/core.diff). The stats endpoint variants are in [`whatif-2/stats-get.ts`](whatif-2/stats-get.ts). With every switch on (and with either stats variant), the patched service passes the conformance suite, 104 of 104 tests.

Contents:

1. [Summary](#1-summary)
2. [Method](#2-method)
3. [SQL statements and prepared statements](#3-sql-statements-and-prepared-statements)
4. [Where the CPU goes](#4-where-the-cpu-goes)
5. [Findings per scenario](#5-findings-per-scenario)
6. [Confirmed opportunities, prioritized](#6-confirmed-opportunities-prioritized)
7. [Rejected hypotheses](#7-rejected-hypotheses)
8. [Files](#8-files)

## 1. Summary

- **Two opportunities are confirmed, and both are big:**
  - **Read small multipart bodies in one call instead of through a `ReadableStream` reader.** This gives +29% on `upload` with 2 workers (3,032 to 3,920 req/s, which reaches the plain-Bun level of 3,821–4,005) and +24–46% with 1 process. App CPU per upload drops by 24–30%.
  - **Compute the stats endpoint in one statement (existence plus aggregate).** This gives +24% with 2 workers (10,664 to 13,278 req/s; plain Bun did 10,591–14,771 in the same window) and +29% with 1 process. PostgreSQL CPU per request drops by 20–22%, and that matters because PostgreSQL is the bottleneck here. The framework has no way to express this query today, so it needs a small new fluent API.
- **One cheap cleanup with a small effect:** cache the aggregate lambda handles per model. It lowers app CPU on `custom` by 6% with 1 process and has no throughput effect with 2 workers, where PostgreSQL limits.
- **Precompiled SQL is already prepared.** Bun 1.4.2 runs `client.unsafe(text, params)` with parameters as a named prepared statement, just like a tagged template. `pg_prepared_statements` shows the statements by name, and `pg_stat_statements` counts 5–6 plans per 200 calls. Running the same text as a tagged template changed nothing measurable.
- **The rest of the gap on `get_user` and `create_user` is spread thin.** The response construction, URL parsing, the `x-request-id` header, a cheaper log line and a leaner insert path each save 2–5% of app CPU, below what this machine can resolve. Together they save 5–9% with 1 process and nothing measurable with 2 workers. Turning logging off entirely saves 9% of app CPU on `get_user`, but the contract measures logging.
- **Upload storage (`mkdir` per object), head-only detection and avoiding the second `File` copy are rejected.** They are visible in the profile (6.3%, 5.8% and 4.7% of sampled JS time), but removing them did not move throughput or CPU per request beyond noise. Writing a `Uint8Array` view instead of a `File` made uploads slower.
- **Statement counts:** `get_user`, `create_user` and `upload` run 1 statement per request, and `custom` runs 2. Round 1's extra round trips are gone.

## 2. Method

**Setup.** The image was built from `benchmarks/quickservicets/Dockerfile` (it pins `QS_WORKERS=1`) at commit `a524bab` and tagged `qsbench-p2-quickservicets`. Every container of this round was named `qsbench-p2-*` and ran on its own network:

- a private PostgreSQL 17.11 with the settings of [`docker-compose.yml`](../docker-compose.yml), plus `pg_stat_statements` (`track=all`, `track_planning=on`);
- the service with `--cpus=2 --memory=1g`;
- k6 (`grafana/k6:2.3.0`, 4 CPUs, 64 VUs) with the scripts in [`load/`](../load/);
- the upload janitor of `run.ts`.

The shared `qsbench-postgres` was not touched. The seed was reloaded before every run. "2 workers" means `-e QS_WORKERS=2` on the same image, which is `server.workers: 2`.

**CPU profiles.** One process ran as `bun --cpu-prof --cpu-prof-dir=/prof --cpu-prof-md .generated/server.ts`, with one container per scenario and 15 seconds of 64-VU load; `docker stop` then wrote the profile. [`tools/analyze.py`](tools/analyze.py) gives the categories and the top functions. The new [`tools/inclusive-2.py`](tools/inclusive-2.py) gives the inclusive share of the components this round looks at, and it also drops the samples taken during the graceful shutdown. The limits from round 1 still apply: the sampler sees only the JS thread, and it ran at about 230–310 samples/s because the machine was loaded. Shares are proportions of sampled JS time, so every conclusion was checked with a throughput experiment.

**SQL.** As in round 1, the statistics were reset, N = 200 sequential requests of one kind were run with [`tools/count-queries.k6.js`](tools/count-queries.k6.js), and the calls were divided by N. Whether statements are prepared was checked three ways:

- `pg_prepared_statements` on a connection that ran `unsafe` and tagged-template queries;
- the server log with `log_min_duration_statement=0`, which shows `parse`, `bind` and `execute` with the statement name;
- `pg_stat_statements.plans` against `calls`.

**Throughput experiments.** The machine was heavily and unevenly loaded (load average 6–27 on 10 cores), and a single baseline swung from 8,885 to 14,563 req/s within minutes. Two things were done about that:

- Every comparison ran as 3 or 4 **rounds in rotated order**: 5 s warmup, then 10 s measured, at 64 VUs, with a fresh container and a fresh seed for each run. The tables report the **median**.
- Each run also recorded the **CPU time per request** of the app and of PostgreSQL. This is `usage_usec` from the container's cgroup `cpu.stat`, taken before and after the measured run and divided by the requests. Time stolen by other load does not count as usage, so this number is steadier than req/s. Runs where PostgreSQL's CPU per request jumped by 30% or more for the same SQL were load spikes; they are visible in the raw results and are not used for conclusions.

The harness is [`whatif-2/harness.sh`](whatif-2/harness.sh), and [`tools/summarize-runs.py`](tools/summarize-runs.py) builds the tables. **A difference under about 10% is not treated as confirmed.** That noise floor is why several plausible micro-optimizations end up in section 7.

Fixed-arrival-rate runs below saturation were tried and dropped: CPU per request doubles there (117 µs against 58 µs on `get_user`), because the event loop has fewer requests to amortize each wake-up, so those runs do not describe the saturated case.

## 3. SQL statements and prepared statements

| Request | Statements | What they are | plans / calls (200) | Plain Bun |
| --- | ---: | --- | --- | ---: |
| `GET /users/{id}` | 1 | `select … from "users" where "id" = $1 limit 1` | 5 / 200 | 1 |
| `POST /users` | 1 | `insert into "users" (…) values ($1…$7) returning …` | 6 / 200 | 1 (no `RETURNING`) |
| `POST /media` | 1 | `insert into "media" (…) values (…) returning …` | 6 / 200 | 1 |
| `GET /organizations/{id}/stats` | 2 | the organization row with `coalesce((select array_agg(…)))` for `members`, then `count(*)`, `count(*) filter (where role = $1)`, `avg(age)` over `users where id = any($2::text[])` | 6 / 200 each | 1 (`LEFT JOIN … GROUP BY`) |

**Bun.sql `unsafe` is prepared.** With parameters, Bun 1.4.2 sends `client.unsafe(text, params)` through the extended protocol as a **named** statement, once per connection. The name is the text plus the parameter types, for example `Pselect $1::int as "unsafe_x".int4$0`. Later calls only `bind` and `execute`. A tagged template behaves exactly the same way, as does a hand-built `TemplateStringsArray` passed to `sql(strings, ...values)` and `unsafe(text, params, { prepare: true })`; all four appeared in `pg_prepared_statements` after three calls each. In the service, `pg_stat_statements` counts 5–6 plans per 200 calls for every statement above. That is PostgreSQL's plan cache settling on a generic plan after the first executions, which a statement re-parsed on every call would not do. The `unsafe` path costs one extra JS check per call (`checkUnsafeTransaction`, 0.3–1.8% of sampled JS time, up to 5% in the upload what-if profile). Removing that check (the `tagged` what-if) did not show in throughput (section 7).

## 4. Where the CPU goes

Inclusive share of sampled JS time, one process. "wi" is the same scenario with its what-if switches on: `fastresp,nourl,logfast` for `get_user`, plus `insfast` for `create_user`, `stats1,fastresp,nourl,logfast` for `custom`, and `nomkdir,directwrite,bufferbody,headdetect,nocopy` for `upload`.

| Inclusive % of sampled JS time | get_user | get_user wi | create_user | create_user wi | custom | custom wi | upload | upload wi |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native, no JS caller (event loop, HTTP, sockets, GC)¹ | 51.1 | | 31.7 | | 34.8 | | 35.2 | |
| `toResponse` (`JSON.stringify` + `Response`) | 15.6 | 16.3 | 11.5 | 11.3 | 5.4 | 7.2 | 3.7 | 8.2 |
| … `JSON.stringify` (Dates through `toJSON`: 2.5–3.4) | 11.1 | 11.6 | 8.8 | 7.9 | 2.5 | 3.3 | 2.8 | 6.6 |
| … `Response` constructor | 5.4 | 7.2 | 3.5 | 4.9 | 3.2 | 5.6 | 1.2 | 1.5 |
| `Headers` objects + `withHeader` (`x-request-id`) | 4.1 | – | 2.8 | – | 2.4 | – | 2.2 | 1.9 |
| request logging (`safeLog` + end-of-turn flush) | 7.9 | 7.3 | 5.0 | 4.9 | 4.0 | 9.6 | 2.1 | 3.5 |
| … stdout `writeSync` | 2.6 | 2.6 | 1.6 | 2.1 | 1.5 | 5.4 | 1.1 | 1.6 |
| `new URL` + `router.match` | 2.3 | 2.6 | 0.7 | 1.1 | 1.3 | 3.0 | 0.5 | 0.9 |
| Bun.sql JS (`internal:sql`, `bun:sql`) | 9.1 | 8.9 | 25.3 | 25.9 | 21.7 | 14.6 | 7.8 | 18.7 |
| PostgreSQL adapter, statements and conditions | 2.1 | 2.6 | 11.3 | 7.0 | 14.8 | – | 3.3 | 5.1 |
| … `compileConditions` / `arrayLiteral` (the `in` list) | | | | | 7.2 / 5.0 | – | | |
| fluent `aggregatesOf` (… `aggregateHandles`) | | | | | 8.6 (7.3) | – | | |
| `splitRelations` / `writeRelations` / `validateBody` | | | 1.9 / – / 1.2 | – / – / 2.0 | | | 0.5 / – / 0.5 | 1.2 / – / 1.0 |
| `readMultipart` | | | | | | | 19.8 | 16.6 |
| … `ReadableStream` reader callbacks (`onRS*`, `onNativePull*`)² | | | | | | | 28.0 | – |
| … `MultipartReader.push` (copying chunks into the body buffer) | | | | | | | 6.8 | – |
| `detectFileType` (`Blob.slice().arrayBuffer()`) | | | | | | | 5.8 | – |
| `new File` (part copy, plus the second copy in `resolveUploadType`) | | | | | | | 4.7 | 6.5 |
| storage `put` (… `mkdir`) | | | | | | | 8.6 (6.3) | 10.0 (–) |
| samples | 3,744 | 3,489 | 4,977 | 3,997 | 5,013 | 2,008 | 4,820 | 2,567 |

¹ From `analyze.py`'s category table (nearest framework frame); not computed for the what-if profiles.
² The reader's callbacks run from microtasks, so they are not under `readMultipart` on the stack; the two rows add up to more than the function itself.

Round 1's largest costs are gone: Drizzle, `structuredClone`, the per-line stdout write and the extra statements. What remains on single-row routes is mostly native (HTTP, sockets, Postgres protocol, GC), Bun.sql's own JS, and building the response.

## 5. Findings per scenario

Numbers are medians of the rotated rounds, in req/s, with app and PostgreSQL CPU per request in µs. "Bun" is `benchmarks/stacks/bun` measured in the same window.

### `upload`

- **Profile.** 28% of sampled JS time goes to the `ReadableStream` reader that `readMultipart` drives chunk by chunk (`req.raw.body.getReader()`), plus 6.8% copying each chunk into the reader's buffer. Plain Bun reads the body with one `arrayBuffer()` call.
- **Why 2 workers barely help.** One upload costs 380–460 µs of app CPU (JS thread, garbage collection threads, the stream machinery), against about 60 µs for `create_user`. The container ran at 125–167% CPU and was throttled by its quota (`nr_throttled` 94), while PostgreSQL sat at about 45% and k6 at about 120%. The limit is CPU per upload inside the 2-CPU quota, not the event loop, so a second process mostly adds contention: with 2 workers, CPU per upload rose to 457–612 µs.

| Variant | 1 process | 2 workers |
| --- | --- | --- |
| baseline | 2,423 · 386 µs (repeat: 2,610 · 384 µs) | 3,032 · 457 µs |
| `bufferbody` (one `bytes()` read, adopted by the reader without a copy) | **3,396 · 296 µs (+40%, −23%)**; repeat 3,215 · 290 µs (+23%, −25%) | **3,920 · 343 µs (+29%, −25%)** |
| `bufferbody` + `nomkdir,directwrite,headdetect,nocopy` | 3,890 · 254 µs; repeats 3,689 · 261 and 3,296 · 285 | 4,038 · 321 µs |
| … + `nofile` (no `File`; `Bun.write` of a `Uint8Array` view) | 2,475 · 339 µs (worse) | |
| Bun, 1 process / 2 processes | 2,737–3,666 · 225–313 µs | 3,821–4,005 · 294–341 µs |

On top of `bufferbody`, the other switches did not separate from noise in two dedicated decomposition runs:

| Variant | Run A | Run B |
| --- | --- | --- |
| `bufferbody` | 3,305 · 270 µs | 3,395 · 299 µs |
| `bufferbody,nomkdir` | 3,593 · 268 µs | |
| `bufferbody,directwrite,headdetect,nocopy` | 3,638 · 279 µs | |
| `bufferbody,headdetect,nocopy` | | 3,443 · 306 µs |
| all five upload switches | 3,116 · 285 µs | 3,296 · 285 µs |

The what-if profile confirms that `mkdir` and the Blob-based detection disappear (section 4), so their real cost is small compared with the rest of an upload.

### `custom` (organization stats)

- **PostgreSQL is the bottleneck even with one process.** 9,572 req/s × 209 µs of PostgreSQL CPU per request is 2.0 CPUs, its whole quota. App-side gains therefore matter only when they also lower PostgreSQL's work.
- **What the two statements cost the database.** The organization row carries its `members` through an `array_agg` subquery, and the aggregate then filters `users` by `id = any($2::text[])`. Plain Bun's single `LEFT JOIN … GROUP BY o.id` does less work.
- **App side.** `aggregateHandles` rebuilds the aggregate handles on every call (7.3%); it also reassigns `sum`/`avg`/`min`/`max` on the cached field handles each time. `compileConditions` and `arrayLiteral` re-encode the 10-id `in` list on every call (12%).

| Variant | 1 process | 2 workers |
| --- | --- | --- |
| baseline (`findById` + fluent `aggregate`) | 9,572 · 97.5 app · 209 PG | 10,664 · 105.5 app · 188 PG |
| `aggcache` (aggregate handles cached per model) | 9,819 · 91.9 · 204 (app −6%) | 10,575 · 104.7 · 189 (±0) |
| `stats2`: existence check and junction-join aggregate sent concurrently (2 statements, no `in` list) | 10,786 · 68.3 · 186 (+13%, PG −11%) | |
| `stats1`: one `LEFT JOIN … GROUP BY` statement (as plain Bun) | **12,325 · 50.9 · 163 (+29%, PG −22%)** | **13,278 · 68.3 · 151 (+24%, PG −20%)** |
| `stats1` + `fastresp,nourl,logfast` | 11,466 · 52.2 · 175 | 12,994 · 68.9 · 155 |
| Bun, 2 processes | | 10,591 · 72.6 · 189 and 14,771 · 52.4 · 136 |

The `stats` variants call `client.unsafe` directly, so their app CPU is a lower bound: a framework implementation adds back its own query building, but not PostgreSQL work, and PostgreSQL is what limits.

### `create_user`

- **Profile.** One statement per create. Bun.sql's JS side takes 25% of sampled JS time, native work 32%, `toResponse` 11.5%, the adapter 11.3% (`written()` filters and sorts the field names on every insert), and `splitRelations` plus the `writeRelations` call, which runs even without reference arrays, 1.9%.
- **Plain Bun's create** builds the response from the values it sent (no `RETURNING`) and does no validation pipeline, so it costs 47.6–61 µs of app CPU against QuickService.ts's 66–99 µs.

| Variant | 1 process | 2 workers |
| --- | --- | --- |
| baseline | 14,196 · 72.0 µs | 16,995 · 99.0 µs (16,420–19,794) |
| `tagged` | 14,337 · 71.4 µs | |
| `insfast` (no split or junction step without reference arrays; insert column list cached) | 15,273 · 67.2 µs | |
| `fastresp,nourl,logfast` | 14,982 · 68.4 µs | |
| `insfast,fastresp,nourl,logfast` | 15,303 · 66.5 µs (+8%, −8%) | 18,559 · 92.2 µs (+9%, −7%) |
| … + `tagged` (second 2-worker block) | | no gain over the same block's baseline (best runs: 24,108 baseline, 22,019 and 21,470 variants) |
| Bun | 17,714–21,147 · 47.6–55.8 µs | 25,504–26,450 · 61 µs |

The combined switches save about 8% of app CPU with one process, near the noise floor. With 2 workers, a second block was hit by load spikes, and its best runs show no gain. **Not confirmed.**

### `get_user`

- **Profile.** One prepared statement per read. Native work is 51% of sampled JS time. The visible JS costs are `toResponse` 15.6% (`JSON.stringify` 11.1%, of which 3.3% is `Date.toJSON`; the `Response` constructor 5.4%), logging 7.9%, Bun.sql 9.1%, `Headers` and `withHeader` 4.1%, and URL plus routing 2.3%. The request id (`randomUUIDv7`) is 0.6%, the hooks pipeline 0.1% and projection 1.8%.

| Variant (4 rotated rounds) | 1 process | 2 workers (3 rounds) |
| --- | --- | --- |
| baseline | 17,564 · 57.7 µs | 29,212 · 61.5 µs |
| `fastresp,nourl` (plain-object headers including `x-request-id`, lazy `Headers`, no `URL` object) | 18,548 · 55.2 µs (−4%) | |
| `logstr` (the same log line built as a string, no entry object or spread) | 18,478 · 55.5 µs (−4%) | |
| `fastresp,nourl,logstr` | 18,715 · 54.7 µs (−5%) | 27,838 · 63.2 µs (±0) |
| `nolog` (bound: no request log at all) | 19,486 · 52.4 µs (−9%) | |
| Bun | 22,673–24,460 · 41–44 µs | 30,372–34,649 · 46–52 µs |

An earlier block gave the same picture: baseline 17,196 · 58.9 µs, `fastresp,nourl,logfast` 19,234 · 53.1 µs, `nolog` 20,185 · 50.7 µs. The remaining gap to plain Bun with 2 workers is about 12 µs of app CPU per request:

- logging accounts for about 5 µs, half of which `logstr` recovers;
- the response, URL and header changes account for 2–3 µs;
- the rest is spread across the async layers of the read path: repository, adapter and handler wrappers.

**No single change is confirmed above the noise floor.**

## 6. Confirmed opportunities, prioritized

### C1. Read small multipart bodies at once (`readMultipart`)

- **Evidence:** the `ReadableStream` reader plus the chunk copies take 35% of sampled JS time on `upload`. The `bufferbody` what-if gave the following (section 5):
  - with 2 workers, +29% req/s (3,032 to 3,920, the plain-Bun level) and −25% app CPU per upload;
  - with 1 process, +23% to +40% req/s and −23% to −25% app CPU.
- **Change** in `packages/core/src/files/upload.ts` `readMultipart` and `packages/core/src/files/multipart.ts` `MultipartReader`:
  - When the request has a `Content-Length` no larger than the part limit plus a fixed allowance for headers and form fields (the what-if used `limit.maxSize + 64 KiB`), read the body with `await req.raw.bytes()`.
  - Hand those bytes to the reader without copying them: a new `MultipartReader` method or constructor option (`adopt(bytes)` in the what-if) that wraps the bytes as its buffer and parses them in one pass.
  - Keep today's streaming path for bodies without a `Content-Length` or above that size, so an oversized file still fails with 413 as soon as its head arrives.
  - `parseEntityUpload` (`files/references.ts`) calls `readMultipart` without a limit. Give it the largest file limit of the entity's file fields, so its uploads take the same path.
  - Behavior, error messages and limits stay the same; only the read strategy changes.
- **Effort:** low (one function, one reader method, tests for both paths: under and over the threshold, missing `Content-Length`, a wrong `Content-Length`, truncated bodies).
- **Risk to simplicity and DX:** none visible to users. Memory per request is unchanged, because the reader already holds the whole body. The only new concept is the size threshold, an internal constant.

### C2. One-statement aggregates over a record's reference array

- **Evidence:**
  - `custom` is PostgreSQL-bound; the endpoint runs 2 statements, one of them a 10-id `in` list built from the first.
  - The single `LEFT JOIN … GROUP BY` statement (`stats1`) gave +29% req/s with 1 process and +24% with 2 workers (13,278 req/s, in the range of plain Bun's 10,591–14,771). PostgreSQL CPU per request fell 20–22%.
  - Two concurrent statements without the `in` list (`stats2`) gave only +13%.
- **Change** in `packages/core/src/fluent-query.ts`, `repository.ts`, `adapter.ts` and `adapters/postgres-statements.ts`, with equivalents in the memory, SQLite and MongoDB adapters. Add a fluent query over the records one record references through a reference array, for example `repos.organizations.related(orgId, "members")`, returning a `Query<User>`:
  - On that query, `aggregate(lambda)` compiles to one statement: `select <aggregates> from <owner> o left join <junction> m on m.owner_id = o.id left join <target> t on t.id = m.target_id where o.id = $1 [and <where>] group by o.id`.
  - It returns `null` when the owner does not exist, so the endpoint's 404 needs no `findById`.
  - Inside the join, `count()` becomes `count(t.id)`, and `count(cond)` becomes `count(t.id) filter (where …)`, so an owner without members gives 0, 0 and `null`.
  - `where`, `all`, `page` and `count` work on the same scoped query, through a join on the junction instead of an `in` list.
  - The stats endpoint becomes `const stats = await repos.organizations.related(id, "members").aggregate(...)`, followed by `if (!stats) throw new HttpError(404, …)`.
- **Effort:** medium. It is new public surface, it needs types (the target entity of the field) and adapter support, plus the `count(t.id)` versus `count(*)` rule under the left join.
- **Risk to simplicity and DX:** moderate, since it adds a concept to learn. It stays in the typed lambda style and replaces a two-step pattern (load the owner, then `in(owner.members)`) that every endpoint over a reference array has to write today. A smaller first step with half the gain (`stats2`, +13%) is a scoped condition (`u.id.inReferencesOf(...)`, a subquery on the junction) plus an existence check sent at the same time.

### C3 (small). Cache the aggregate handles per model

- **Evidence:** `aggregateHandles` takes 7.3% of sampled JS time on `custom`. Caching the handles lowered app CPU per request by 6% with 1 process (97.5 to 91.9 µs). Throughput did not change measurably (+3% with 1 process, ±0 with 2 workers), because PostgreSQL limits that scenario.
- **Change:** in `packages/core/src/fluent-query.ts`, build the aggregate handles once per model in a `WeakMap`, as `fieldHandles` already does. Build them as a separate object instead of assigning `sum`/`avg`/`min`/`max` onto the cached field handles on every call: today those functions leak into `where` lambdas, and the patch keeps that existing leak. Compiling the `in` list with `arrayLiteral` on every call (5%) goes away for this endpoint with C2.
- **Effort:** very low. **Risk:** none.

## 7. Rejected hypotheses

| Hypothesis | What was measured | Verdict |
| --- | --- | --- |
| Precompiled SQL runs unprepared through `client.unsafe` | Bun 1.4.2 prepares `unsafe(text, params)` by name; `pg_stat_statements` shows 5–6 plans per 200 calls. `tagged` (a cached `TemplateStringsArray` per text): `create_user` 14,337 · 71.4 µs against 14,196 · 72.0 µs; no gain with 2 workers | Rejected: already prepared; `checkUnsafeTransaction` (≤ 2% of JS time) is not worth a change |
| `mkdir` per stored object | 6.3% of sampled JS time; `bufferbody,nomkdir` 3,593 · 268 µs against `bufferbody` 3,305 · 270 µs (same block) | No effect beyond noise. Dropping the `mkdir` is still safe (`Bun.write` creates missing folders on Linux and macOS) and simplifies `local.ts`, but it is not a performance item |
| Streaming or direct write, no `new Response(body)` | `directwrite` together with `headdetect,nocopy`: 3,638 · 279 µs against 3,305 · 270 µs | No effect |
| Detection from the head only | `detectFileType` disappears from the profile (5.8% to –); `bufferbody,headdetect,nocopy` 3,443 · 306 µs against 3,395 · 299 µs | No effect |
| No extra copies of the file | Skipping the second `File` in `resolveUploadType` (`nocopy`): no effect. Skipping `File` entirely (`nofile`): 2,475 · 339 µs against 3,890 · 254 µs | Rejected; writing a `Uint8Array` view through `Bun.write` was slower here than writing a `File` |
| 2 workers for uploads | Base: 2,423–2,610 (1 process) against 3,032 (2 workers) in different blocks, with CPU per upload rising from 386 to 457–612 µs | Uploads are bound by CPU per upload within the container quota; C1 is the lever |
| Response building (`fastresp`), no `URL` object (`nourl`) | `get_user` −4% app CPU with 1 process; ±0 with 2 workers | Below the noise floor |
| Cheaper log line (`logfast`, `logstr`) | −4% app CPU on `get_user`; no logging at all would be −9% | Below the noise floor; logging is part of the contract |
| Lean insert path (`insfast`) | `create_user` −7% app CPU with 1 process; combined with the response switches, −8% (1 process) and −7% (2 workers, first block) | Below the noise floor |
| Request id (UUIDv7), hooks pipeline | 0.6% and 0.1% of sampled JS time | Not worth an experiment |

The changes in the last four rows are each small, internal and low-risk, and together they save 5–9% of app CPU on single-row routes. They could be bundled into one tidy-up. On this machine, though, a gain of that size cannot be confirmed, so it should be measured again on a quiet host before it is promised.

## 8. Files

| Path | What it is |
| --- | --- |
| [`profiles-2/<scenario>.cpuprofile`](profiles-2/) | Bun CPU profiles of the shipped core (15 s of 64-VU load, 1 process) for `get_user`, `create_user`, `custom` and `upload` |
| `profiles-2/<scenario>.whatif.cpuprofile` | The same scenarios with the what-if switches of section 4 |
| [`tools/inclusive-2.py`](tools/inclusive-2.py) | The round-2 component table: `python3 tools/inclusive-2.py get_user=profiles-2/get_user.cpuprofile …` |
| [`tools/summarize-runs.py`](tools/summarize-runs.py) | Medians per variant from the harness's results file: `python3 tools/summarize-runs.py <tag> results.txt` |
| [`whatif-2/core.diff`](whatif-2/core.diff) | The what-if patch, applied to a copy of `packages/core/src` (`git apply` from the repository root, on a copy) and gated by `QS_WHATIF`. Switches: `tagged`, `insfast`, `nomkdir`, `directwrite`, `bufferbody`, `headdetect`, `nocopy`, `nofile`, `aggcache`, `fastresp`, `nourl`, `logfast`, `logstr`, `nolog` |
| [`whatif-2/stats-get.ts`](whatif-2/stats-get.ts) | The stats endpoint with the `stats1` and `stats2` variants, mounted over `endpoints/organizations/[orgId]/stats/get.ts` |
| [`whatif-2/harness.sh`](whatif-2/harness.sh) | The shell helpers used for every run: private PostgreSQL and service containers, rotated rounds, CPU per request from cgroup `cpu.stat` |
