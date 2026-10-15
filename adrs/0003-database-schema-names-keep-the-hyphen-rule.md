# 0003 - DATABASE_SCHEMA keeps the hyphen naming rule

- Date: 2026-10-15
- Spec: 0041-sql-schema-storage
- Status: accepted

## Context
Spec 0041 AC2 sets `DATABASE_SCHEMA=tenant_a`, but spec 0040 R5 validates schema names with `^[a-z][a-z0-9-]*$`,
which rejects underscores. The two specs contradict each other.

## Options considered
- A: Keep the 0040 rule and read AC2 as `DATABASE_SCHEMA=tenant-a`, whose database identifier is `tenant_a` — same
  resulting tables, no change to an already built validation rule.
- B: Also allow underscores in schema names — AC2 works literally, but two spellings map to the same identifier.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Tests use `DATABASE_SCHEMA=tenant-a` and assert tables in `tenant_a`. Spec 0041 AC2 should say `tenant-a` in an
`update-spec`.
