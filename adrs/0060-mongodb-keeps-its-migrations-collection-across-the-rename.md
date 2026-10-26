# 0060 - MongoDB keeps its `_migrations` collection across the rename

- Date: 2026-10-26
- Spec: 0839-rename-to-quickservice-ts
- Status: accepted

## Context
Spec 0839 R8 renames the migrations table `__quickservice_migrations` to `__quickservicets_migrations` once, and AC8
asks for "a MongoDB database holding `__quickservice_migrations`" to be migrated after the rename without re-running any
applied migration. On MongoDB the history has always been the collection `_migrations` (spec 0026), which carries no
product name, so no MongoDB database written by the framework holds `__quickservice_migrations`.

## Options considered
- A: Leave MongoDB's `_migrations` collection as it is; on MongoDB the rename has nothing to do, and the test shows that
  a database migrated before the rename keeps its history and applies only new migrations — no invented name, no data
  moved.
- B: Rename `_migrations` to `__quickservicets_migrations` on MongoDB too, for one name across adapters — changes a
  collection that never needed renaming, and every MongoDB migration script and doc that names `_migrations`.
- C: Also look for a `__quickservice_migrations` collection on MongoDB and rename it — handles a collection the
  framework never created.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`renameLegacyMigrationTables` renames tables on SQLite and PostgreSQL only (default schema, tenant schemas and explicit
schemas) and returns no rename for MongoDB and the memory adapter. AC8 is verified on MongoDB as "the history survives
and no migration runs again".
