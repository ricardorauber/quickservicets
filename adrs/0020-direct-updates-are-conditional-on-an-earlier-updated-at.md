# 0020 - A direct update is conditional on an earlier `updatedAt`, and falls back to reading the record

- Date: 2026-10-19
- Spec: 0112-single-statement-writes
- Status: accepted

## Context
Spec 0112 R3 asks `update` to run as one `UPDATE … RETURNING *`, with zero rows answering 404. The repository read
the record first to set `updatedAt` strictly after the stored value (`nextTimestamp(current.updatedAt)`), so an
update in the same millisecond as the previous write still moves `updatedAt` forward. Without that read, the new
`updatedAt` could equal the stored one.

## Options considered
- A: Update with `updatedAt = now` only `WHERE updatedAt < now` (the existing `where` argument of `updateById`). A
  missing record, or one written at or after `now`, updates nothing; the repository then reads it, answering 404 or
  updating with a later timestamp as before. One statement in the usual case, on every adapter, with no change to
  timestamps.
- B: Drop the guarantee and set `updatedAt = now` unconditionally — one statement always, but two writes in the same
  millisecond leave `updatedAt` unchanged.
- C: Compute `greatest(now, updated_at + 1ms)` in SQL — PostgreSQL-specific; SQLite, MongoDB and memory would need
  their own versions.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
For entities without relation sides to sync, `@onConflict replace` or replaced files to remove, `update` and `replace`
run one conditional update. A miss costs one more read: 404 for an unknown id, or the previous read-then-update path
when the record was written in the same millisecond.
