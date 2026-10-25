# 0049 - The etag example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0197-etag-reads
- Status: accepted

## Context
Spec 0197 registers the `etag` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The etag example is spec 0199, so the check would fail on specs 0197 and 0198.

## Options considered
- A: Add `examples/minimal/etag` with spec 0197, showing what exists at that point (`etag: {}`, its variable, `res.etag`
  in a custom endpoint, eject) and `Not applicable:` lines for the levels later specs add; spec 0199 brings it to its
  final content. This is what ADRs 0040, 0041, 0044, 0046 and 0047 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0199: breaks specs 0197 and 0198, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/etag` exists from spec 0197 with a `Document` entity and a 304 test; spec 0199 adds the lost-update,
428 and tagger tests and the README snippets it specifies.
