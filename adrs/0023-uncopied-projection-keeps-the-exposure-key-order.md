# 0023 - A projection returns the record uncopied only when its keys are already in the exposure's order

- Date: 2026-10-19
- Spec: 0114-projection-without-clones
- Status: accepted

## Context
Spec 0114 R2 asks projection to return the record without copying when its exposure keeps every field and the
request selects nothing, and R4 asks responses to stay identical to today's. Today `keep` builds each object in the
order of the exposure's `include` list (`id`, `createdAt`, `updatedAt`, then the declared fields), so that is the key
order of every JSON response. Records do not always arrive in that order: the PostgreSQL adapter returns the system
columns first and appends reference arrays and computed fields, while the memory adapter and MongoDB put the declared
fields before `createdAt` and `updatedAt`. Returning such a record as it is would change the key order of the response
body, which the spec does not decide.

## Options considered
- A: Return the record itself only when its own keys are exactly the kept keys, already in the exposure's order (and
  every kept subtree is unchanged); otherwise build one new object per changed level, sharing every value — responses
  stay byte-for-byte identical, and the uncopied path applies to the common PostgreSQL case; records in another order
  still pay one shallow object per record.
- B: Return the record itself whenever its keys are all exposed, whatever their order — the uncopied path applies to
  every adapter, but response bodies change key order depending on the adapter and on populated or computed fields.
- C: Reorder records in each adapter to the exposure's order — every adapter would pay a copy to save one later, and
  the adapters are outside this spec's scope.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`keep` in `packages/core/src/projection.ts` compares the record's own keys with the kept keys while it walks the
include tree and returns the input when they match in order; `remove` returns the input when none of its paths is
present. Response bodies keep today's key order for every adapter.
