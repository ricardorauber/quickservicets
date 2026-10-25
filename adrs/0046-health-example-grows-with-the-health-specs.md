# 0046 - The health example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0192-health-checks
- Status: accepted

## Context
Spec 0192 registers the `health` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The health example is spec 0194, two specs later, so the check would fail on specs 0192 and 0193.

## Options considered
- A: Add `examples/minimal/health` with spec 0192, showing what exists at that point (`health: {}`, the options and
  their variables, eject) and `Not applicable:` lines for the levels later specs add; spec 0194 brings it to its final
  content. This is what ADRs 0040, 0041 and 0044 chose for the events, security and queues examples.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0194: breaks specs 0192 and 0193, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/health` exists from spec 0192 with a `User` entity and a test of both routes; spec 0194 adds the
config check, the project feature's check, the overriding ready endpoint, draining and the README snippets per level.
