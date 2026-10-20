# 0022 - On SQLite the count still runs after the page

- Date: 2026-10-19
- Spec: 0116-count-only-when-needed
- Status: accepted

## Context
Spec 0116 R3 asks list routes and `page()` to run the page query and the count concurrently on SQL adapters. The
PostgreSQL adapter sends both over its connection pool at once. The SQLite adapter uses `bun:sqlite`, whose
statements run synchronously in the server process, so two statements cannot overlap.

## Options considered
- A: Run both in `Promise.all` on PostgreSQL and keep SQLite sequential — no change in SQLite latency is possible, and
  the code stays plain.
- B: Wrap the SQLite statements in `Promise.all` too — the statements would still run one after the other, so the
  code would only look concurrent.
- C: Run SQLite counts in a worker thread with its own connection — real overlap, but a second connection breaks
  transactions and `:memory:` databases.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`findMany` on PostgreSQL issues the page and the `count(*)` together when the total is wanted. On SQLite it runs
them in sequence, as before; both adapters skip the count when `withTotal` is false.
