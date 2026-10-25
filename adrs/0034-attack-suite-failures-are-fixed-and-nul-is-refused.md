# 0034 - Failures found by the attack suite are fixed, and NUL characters are refused

- Date: 2026-10-25
- Spec: 0132-attack-test-suite
- Status: accepted

## Context
Spec 0132 adds an attack suite that "records today's guarantees" and lists fixing behavior as out of scope, while its
requirements say what every adapter SHALL do and AC1 asks for every test to pass. Run against the four adapters, the
suite found two places where today's behavior breaks those requirements:

- A JSON body with a top-level `__proto__` key was accepted with 201: copying the body into a plain object assigned
  the key as a prototype, so it was neither stored nor reported as `Unknown field` (R5).
- A string holding a NUL character (U+0000) failed differently on each adapter: PostgreSQL rejects it in any text
  parameter (500 on writes, filters and path ids), MongoDB refuses it in the regular expressions of `contains` and
  `startsWith` (500), and SQLite's `LIKE` stops at it, so `contains` matched unrelated records (R1, R2).

## Options considered
- A: Fix both in the same change: validate bodies on an object without a prototype, so `__proto__` is reported as
  `Unknown field`; refuse U+0000 in string values (400 `Must not contain NUL characters` in bodies and filters) and in
  path segments (400 `Invalid path`), the same on every adapter. The suite expects 400 for the NUL payload. Small
  changes, one behavior everywhere; a NUL character can no longer be stored, which PostgreSQL never allowed anyway.
- B: Fix `__proto__`, and handle NUL per adapter (escape it in MongoDB regular expressions, avoid `LIKE` on SQLite,
  refuse it on PostgreSQL) — the adapters would disagree on whether a NUL can be stored, which the suite exists to
  prevent.
- C: Keep the behavior and mark the failing tests as known failures — AC1 would stay unchecked and the guarantees the
  spec states would not hold.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`validateBody` copies the writable keys into an object created with `Object.create(null)`. String values in bodies,
filter values (including `in` items and typed query items) and decoded path segments are refused when they contain
U+0000. The validation guide lists the new message. The suite's NUL payload asserts 400 instead of a stored record;
the spec text about a stored payload reading back unchanged applies to every other payload.
