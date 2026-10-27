# 0071 - The tenancy example starts with the native and grows with the tenancy specs

- Date: 2026-10-27
- Spec: 0232-tenancy-feature-and-tenant-resolution
- Status: accepted

## Context
Spec 0232 registers the `tenancy` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`, and the features guide must list every native. The tenancy example and guide are spec 0244, so
the checks would fail on specs 0232 to 0243.

## Options considered
- A: Add `examples/minimal/tenancy` with spec 0232, showing what exists at that point (tenant resolution from a header,
  an exempt endpoint, the missing-tenant answer, eject) with `Not applicable:` lines for the levels later specs add, and
  a row in the features guide; spec 0244 brings both to their final content. ADRs 0049 to 0069 chose this for the
  earlier natives.
- B: Let the checks skip natives without an example until a later spec: weakens spec 0158.
- C: Register the native only in spec 0244: breaks the specs that build and test it.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/tenancy` exists from spec 0232; the later tenancy specs keep it passing, and spec 0244 adds the
strategies, the shared entity, the consumer, the job and the README levels it specifies.
