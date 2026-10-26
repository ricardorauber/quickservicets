# 0056 - The errors example starts with the native and grows with the error reporting specs

- Date: 2026-10-26
- Spec: 0209-error-reporter-interface
- Status: accepted

## Context
Spec 0209 registers the `errors` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The errors example is spec 0211, so the check would fail on specs 0209 and 0210.

## Options considered
- A: Add `examples/minimal/errors` with spec 0209, showing what exists at that point (`errors: {}`, `release` and its
  variable, a reporter, the throwing endpoint of spec 0211, eject) and `Not applicable:` lines for the levels later
  specs add; spec 0211 brings it to its final content. This is what ADRs 0049, 0051 and 0053 chose for earlier
  natives.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0211: breaks specs 0209 and 0210, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/errors` exists from spec 0209 with the throwing endpoint and a memory reporter test; spec 0211 adds
the failing job and the README snippets it specifies.
