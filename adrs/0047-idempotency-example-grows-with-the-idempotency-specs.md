# 0047 - The idempotency example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0195-idempotency-keys
- Status: accepted

## Context
Spec 0195 registers the `idempotency` native. The repository test of spec 0158 requires every registered native to have
a complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The idempotency example is spec 0196, so the check would fail on spec 0195.

## Options considered
- A: Add `examples/minimal/idempotency` with spec 0195, showing what exists at that point (`idempotency: {}`, the
  options and their variables, the `@idempotent` tag, eject) and `Not applicable:` lines for the levels spec 0196 adds;
  spec 0196 brings it to its final content. This is what ADRs 0040, 0041, 0044 and 0046 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0196: breaks spec 0195, which builds and tests the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/idempotency` exists from spec 0195 with an `Order` entity and a replay test; spec 0196 adds the
`@idempotent required=true` tag, the `POST /payments` endpoint and the tests and README snippets it specifies.
