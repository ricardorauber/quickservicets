# 0082 - Reference array pulls across databases run in the application

- Date: 2026-10-29
- Spec: 0881-references-across-databases
- Status: accepted

## Context
Spec 0881 allows references and reference arrays to entities of another database. It fails the build for
`@onDelete cascade` and `setNull` across databases and keeps `restrict` as an application check, but it says nothing
about `pull`, the default rule of reference arrays: deleting a target record removes its id from every array that
lists it, which across databases is a write in the other database. On one database the adapter pulls the id from the
junction rows in the same statement as the delete; across databases no statement can reach both.

## Options considered
- A: Pull across databases in the application: the delete reads the arrays of the other database that list the id
  and rewrites each record without it, like an adapter without in-place pulls does today. Not atomic with the
  delete, documented next to the non-atomic `restrict` check. The default stays usable.
- B: Fail the build for `pull` across databases like `setNull`: every reference array across databases would need
  `@onDelete restrict`, although the spec allows them with their defaults.
- C: Leave the ids in place: arrays would list records that no longer exist.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Reference arrays of another database are never pulled in place; their records are updated one by one by the delete
plan, and the guide says the pull is not atomic with the delete. Spec 0881 R3 should name `pull` when it is next
updated.
