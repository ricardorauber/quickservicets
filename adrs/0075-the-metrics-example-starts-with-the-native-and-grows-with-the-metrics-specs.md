# 0075 - The metrics example starts with the native and grows with the metrics specs

- Date: 2026-10-28
- Spec: 0262-request-observations-and-usage-metrics
- Status: accepted

## Context
Spec 0262 registers the `metrics` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`, and the features guide must list every native with a guide link and a reference link. The metrics
example and the usage metrics guide are spec 0265, so the checks would fail on specs 0262 to 0264.

## Options considered
- A: Add `examples/minimal/metrics` with spec 0262, showing what exists at that point (enabling, the options and their
  variables, `observeRequests`, eject) with `Not applicable:` lines for the levels later specs add, and a row in the
  features guide linking the configuration guide until the usage metrics guide exists; spec 0265 brings both to their
  final content. ADRs 0049 to 0072 chose this for the earlier natives.
- B: Let the checks skip natives without an example until a later spec: weakens spec 0158.
- C: Register the native only in spec 0265: breaks the specs that build and test it.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/metrics` exists from spec 0262; specs 0263 and 0264 keep it passing, and spec 0265 adds the SQLite
database store, tenancy, the endpoint that fails one time in five, the README levels and the end-to-end checks it
specifies, and points the features guide row at the usage metrics guide.
