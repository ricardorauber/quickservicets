# 0021 - Deletes pull junction-stored references through an optional `deleteAndPull` adapter operation

- Date: 2026-10-19
- Spec: 0113-single-statement-deletes
- Status: accepted

## Context
Spec 0113 asks a delete to remove the deleted id from junction-stored reference arrays by deleting only the matching
junction rows and refreshing their owners' `updatedAt` in one statement (R3), with at most 2 statements for a user in
no organization and at most 4 for a member (AC1, AC2). The core plans deletes without knowing the database, and the
adapter interface only had `updateById` and `deleteById`, so a pull rewrote each owner's whole list. MongoDB is out of
scope, and custom adapters must keep working.

## Options considered
- A: An optional adapter operation, `deleteAndPull(entity, id, pulls, updatedAt)`, that deletes the record and pulls
  its id from the given reference arrays in the same atomic write. PostgreSQL runs it as one statement (data-modifying
  CTEs: `delete from <junction> where target_id = $1 returning owner_id`, one `update` of each owner table's
  `updated_at`, then the record's `delete`), SQLite as a short transaction. A delete with no other effects is then
  the read plus one statement, with no transaction, whether or not the record is in any array. Adapters without it
  (MongoDB, memory, custom ones) keep the current rewrite.
- B: A separate `pullReferences` operation run before `deleteById` — always a pull statement plus the delete inside a
  transaction: 4 statements (plus the read) even for a record in no array, which misses AC1.
- C: Rely on the junction foreign key's `ON DELETE CASCADE` and refresh owners in a statement before the delete —
  two statements without atomicity, so a failed delete could leave owners refreshed.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`DatabaseAdapter.deleteAndPull` is optional; the PostgreSQL and SQLite adapters implement it. `planDelete` attaches
the junction pulls (`@onDelete pull` reference arrays) to each planned deletion and only reads the owners when a
`@minItems` must be checked; `executeDeletePlan` skips the transaction when the plan is a single write. Owners'
`updatedAt` becomes the delete time, or 1 ms after the stored value when that is not earlier, as before. Remaining
junction rows keep their positions (with a gap), so reads return the same order. Referencing records are read in pages
without a count first, and `delete` reads the deleted record once, reusing it for file cleanup, which only runs (in a
transaction) when the delete can remove stored objects.
