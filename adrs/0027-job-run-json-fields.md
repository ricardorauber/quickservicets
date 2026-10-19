# 0027 - JobRun stores `result` as any JSON value and log times as ISO strings

- Date: 2026-10-19
- Spec: 0105-job-runs-and-config
- Status: accepted

## Context
Spec 0105 R1 gives `JobRun` a `result` (JSON, optional) and `logs` (`{ level, message, at, fields? }[]`). The entity
model had no field type for an arbitrary JSON value: objects and arrays must declare their fields. Dates nested in JSON
columns are also not converted back on read, so a nested `at: Date` would come back as a string on SQLite and
PostgreSQL but as a `Date` on MongoDB and memory.

## Options considered
- A: Add a `json` field type (any JSON value, JSON storage, typed `unknown`) used by `result` and `logs[].fields`, and
  store `logs[].at` as an ISO 8601 string — the same value and type on every database.
- B: Store `result` as serialized text and `at` as a nested date — no new field type, but readers must parse the
  result, and the type of `at` would differ by database.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`TypeDescriptor` gains `{ type: "json" }`: generated types use `unknown`, the OpenAPI schema is `{}`, validation keeps
the value, and it is neither filterable nor sortable. Only built-in entities use it; `/entities` cannot declare it.
Writers of run records (specs 0106 to 0110) set `logs[].at` with `new Date().toISOString()`.
