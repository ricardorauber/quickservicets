# 0069 - The http example starts with the native and grows with the HTTP client specs

- Date: 2026-10-27
- Spec: 0217-http-client-builder
- Status: accepted

## Context
Spec 0217 registers the `http` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The HTTP client example is spec 0226, so the check would fail on specs 0217 to 0225.

## Options considered
- A: Add `examples/minimal/http` with spec 0217, showing what exists at that point (`GET /quote` calling a local
  upstream, the 502 answer, eject) and `Not applicable:` lines for the levels later specs add; spec 0226 brings it to
  its final content. This is what ADRs 0049, 0051, 0053, 0056 and 0058 chose for earlier natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0226: breaks specs 0217 to 0225, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/http` exists from spec 0217 with `GET /quote` and its test; spec 0226 adds the upstream script, the
services, the job and the README snippets it specifies.
