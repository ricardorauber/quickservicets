# 0019 - `updateById` resolves the stored record or null, and the contract asserts on it

- Date: 2026-10-19
- Spec: 0112-single-statement-writes
- Status: accepted

## Context
Spec 0112 R2 asks `adapter.updateById` to return the stored row (`RETURNING *`) so the repository can answer without
reading the record again. The adapter interface resolved a boolean, and R5 asks every existing adapter contract test
to stay unchanged; several contract tests assert `toBe(true)` and `toBe(false)` on the result.

## Options considered
- A: Change the result to `StoredRecord | null` and adapt only the assertions on the result: a record where they
  expected `true`, `null` where they expected `false`. Every scenario and expectation on the data stays. Truthiness is
  unchanged, so callers that test the result (the job scheduler's conditional claims) keep working.
- B: Keep `updateById` boolean and add a second method that returns the row — two ways to do one thing, and a custom
  adapter must implement both.
- C: Keep the boolean and re-read the record in the repository — contradicts R2 and keeps the extra round trip.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`DatabaseAdapter.updateById` resolves the record as stored after the update, with its reference arrays, or null when
no record matched. The memory, SQLite, PostgreSQL and MongoDB adapters return it (`UPDATE … RETURNING`, or
`findOneAndUpdate` on MongoDB). The contract suite checks the returned record against `findById`, and that `insert`
returns the record `findById` reads. Custom adapters must return the record instead of `true`.
