# 0041 - The security example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0168-security-feature-and-item-toggles
- Status: accepted

## Context
Spec 0168 registers the `security` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The security example is spec 0182, fourteen specs later, so the check would fail on every spec from
0168 to 0181, and each spec must leave the suite green.

## Options considered
- A: Add `examples/minimal/security` with spec 0168, showing what exists at that point (the default-on native,
  `security: false`, item switches and their variables, an exemption from a project feature, eject) and `Not applicable:`
  lines for the levels later specs add; the following specs extend it, and spec 0182 brings it to its final content and
  guide. This is what ADR 0040 chose for the events example.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0182: breaks specs 0168 to 0181, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/security` exists from spec 0168 with a `Post` entity and a `probes` project feature; spec 0182
rewrites it with the `Post` and `Customer` entities, the tagged endpoints, the README snippets per level and the guide it
specifies.
