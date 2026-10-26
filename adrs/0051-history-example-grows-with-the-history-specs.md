# 0051 - The history example starts with the native and grows with its specs

- Date: 2026-10-26
- Spec: 0200-entity-history-tables
- Status: accepted

## Context
Spec 0200 registers the `history` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The history example is spec 0204, so the check would fail on specs 0200 to 0203.

## Options considered
- A: Add `examples/minimal/history` with spec 0200, showing what exists at that point (`history: {}`, `entities`,
  its variable, the entity and field tags, eject) and `Not applicable:` lines for the levels later specs add; spec 0204
  brings it to its final content. This is what ADRs 0040, 0041, 0044, 0046, 0047 and 0049 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0204: breaks specs 0200 to 0203, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/history` exists from spec 0200 with the `Document` and `Draft` entities of spec 0204 and a test of
the stored versions; spec 0204 adds the routes, prune and README snippets it specifies.
