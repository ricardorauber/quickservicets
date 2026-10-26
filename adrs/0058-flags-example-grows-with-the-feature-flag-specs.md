# 0058 - The flags example starts with the native and grows with the feature flag specs

- Date: 2026-10-26
- Spec: 0212-feature-flags
- Status: accepted

## Context
Spec 0212 registers the `flags` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The flags example is spec 0216, so the check would fail on specs 0212 to 0215.

## Options considered
- A: Add `examples/minimal/flags` with spec 0212, showing what exists at that point (`flags: {}`, the rules of spec
  0216, `GET /settings`, the demo user hook, eject) and `Not applicable:` lines for the levels later specs add; spec
  0216 brings it to its final content. This is what ADRs 0049, 0051, 0053 and 0056 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0216: breaks specs 0212 to 0215, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/flags` exists from spec 0212 with the `Product` entity, `GET /settings` and its test; spec 0216 adds
the gated checkout, the job and the README snippets it specifies.
