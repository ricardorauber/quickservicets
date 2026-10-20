# 0035 - Related queries are optional adapter methods with a generic fallback

- Date: 2026-10-20
- Spec: 0130-related-queries
- Status: accepted

## Context
Spec 0130 adds `repos.<entity>.related(id, field)`, a query over the records a reference array lists, with support
in the memory, SQLite, PostgreSQL and MongoDB adapters and a one-statement `aggregate` on SQL adapters. The spec does
not say how adapters receive the scope (owner entity, owner id and field), or what happens with a `DatabaseAdapter`
written outside the framework that does not know about it.

## Options considered
- A: Three optional adapter methods, `findRelated`, `countRelated` and `aggregateRelated`, taking a `RelatedScope`.
  The four built-in adapters implement them; without them, the repository reads the owner's array and filters the
  target by id (two round trips, the same results). Follows the existing optional `deleteAndPull`; existing custom
  adapters keep working.
- B: The same three methods, required — no fallback code, but every custom adapter and adapter stub stops
  type-checking until it implements them.
- C: An optional `related` scope on `findMany`, `count` and `aggregate` — no new methods, but an adapter that ignores
  the new argument returns wrong results silently, and `aggregate` would have to change its return type to allow
  `null`.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`DatabaseAdapter` gains `findRelated?`, `countRelated?` and `aggregateRelated?` and `RelatedScope`. PostgreSQL and
SQLite answer each with one statement (an `in` subquery on the junction for pages and counts; the owner left-joined to
its junction and target for aggregates). The memory and MongoDB adapters read the owner's array, then the target
records (MongoDB reads only the array field, since the target can live in another database).
