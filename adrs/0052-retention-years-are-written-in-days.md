# 0052 - Retentions of years are written in days

- Date: 2026-10-26
- Spec: 0203-history-customization
- Status: accepted

## Context
Spec 0203 AC3 writes a per-tenant retention as `tenant === "pro" ? "5y" : "90d"`. Durations (spec 0135) accept the
units `s`, `m`, `h` and `d` only, so `"5y"` is an invalid result, which R3 requires to fail the prune naming
`history.retention`. The criterion cannot pass as written without changing the duration syntax of every option.

## Options considered
- A: Keep the duration units and write five years as `"1825d"` in the test and the docs — no change to a syntax every
  native shares; the criterion's intent (a long retention for one tenant, a short one for the other) holds.
- B: Add a `y` unit (365 days) to durations — touches every duration option, its environment parsing and docs, for one
  example.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The test of AC3 uses `"1825d"`; the history guide and example write long retentions in days. A later spec may add
longer units to durations for every option at once.
