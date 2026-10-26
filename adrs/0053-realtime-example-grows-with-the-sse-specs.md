# 0053 - The realtime example starts with the native and grows with the SSE specs

- Date: 2026-10-26
- Spec: 0205-sse-endpoints
- Status: accepted

## Context
Spec 0205 registers the `realtime` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The realtime example is spec 0208, so the check would fail on specs 0205 to 0207.

## Options considered
- A: Add `examples/minimal/realtime` with spec 0205, showing what exists at that point (`realtime: {}`, the `sse`
  options and their variables, the `endpoints/clock/sse.ts` of spec 0208, eject) and `Not applicable:` lines for the
  levels later specs add; spec 0208 brings it to its final content. This is what ADRs 0040, 0041, 0044, 0046, 0047,
  0049 and 0051 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0208: breaks specs 0205 to 0207, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/realtime` exists from spec 0205 with the clock stream and its test; spec 0208 adds the `Task`
entity, the change stream, resume and the README snippets it specifies.
