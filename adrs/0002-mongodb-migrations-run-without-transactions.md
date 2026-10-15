# 0002 - MongoDB migrations run without multi-document transactions

- Date: 2026-10-15
- Spec: 0062-mongodb-migrations
- Status: accepted

## Context
Spec 0062 R4 asks each MongoDB migration to run in a transaction when the server supports it. MongoDB rejects index
creation on an existing collection inside a multi-document transaction ("Cannot create new indexes on existing
collection ... in a multi-document transaction"), and index changes are the main content of generated MongoDB
migrations, so wrapping migrations in a transaction would make them fail.

## Options considered
- A: Run MongoDB migrations without a multi-document transaction, record history after each successful migration,
  and print a warning once per run — generated migrations always work; a failing migration may leave partial changes.
- B: Use a transaction only for migrations without index operations — inconsistent behavior between migrations.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`migrate` on MongoDB prints "MongoDB migrations run without transactions" once, runs `up`/`down` outside a
transaction and writes `_migrations` only after the migration succeeds. Spec 0062 R4/AC5 should be read accordingly;
an `update-spec` can align its wording.
