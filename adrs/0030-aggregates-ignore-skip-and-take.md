# 0030 - Aggregates cover every match and ignore skip and take

- Date: 2026-10-19
- Spec: 0121-fluent-aggregates
- Status: accepted

## Context
Spec 0121 adds a terminal `aggregate(lambda)` to fluent queries that computes counts, sums, averages, minimums and
maximums of "a filtered query". A query can also carry `skip`, `take`, ordering, `select` and `include`, and the spec
does not say whether those change what `aggregate` computes.

## Options considered
- A: Aggregate every record that matches the conditions and ignore `skip`, `take`, ordering, `select` and `include`,
  as `count()` and `any()` already do — one plain `select ... where` statement; aggregating a slice needs a separate
  query.
- B: Apply `skip` and `take` (aggregate the slice in the current order) — needs a subquery with `order by`, `limit` and
  `offset` on SQL and extra pipeline stages on MongoDB, and behaves differently from `count()`.
- C: Throw when `skip` or `take` was set — explicit, but rejects queries that are otherwise valid.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`aggregate` passes only the query's conditions to the adapters. Its doc comment and the queries guide say that `skip`,
`take`, ordering, `select` and `include` do not apply.
