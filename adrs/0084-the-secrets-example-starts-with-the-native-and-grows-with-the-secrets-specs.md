# 0084 - The secrets example starts with the native and grows with the secrets specs

- Date: 2026-11-02
- Spec: 0276-secret-references-and-resolution
- Status: accepted

## Context
Spec 0276 registers the `secrets` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`, and the features guide must list every native with a guide link and a reference link. The secrets
example and the secrets guide are spec 0280, so the checks would fail on specs 0276 to 0279.

## Options considered
- A: Add `examples/minimal/secrets` with spec 0276, showing what exists at that point (a `file://` reference in a
  declared secret variable, the `timeout` and `retries` options and their variables, a provider registered by a
  feature, eject) with `Not applicable:` lines for the levels later specs add, and a row in the features guide linking
  the environment guide until the secrets guide exists; spec 0280 brings both to their final content. ADRs 0071, 0072,
  0075 and 0077 chose this for earlier natives.
- B: Let the checks skip natives without an example until a later spec: weakens spec 0158.
- C: Register the native only in spec 0280: breaks the specs that build and test it.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/secrets` exists from spec 0276; specs 0277 to 0279 keep it passing, and spec 0280 adds the
`env://` database URL, the `file://secrets/api-key` key with its seed script, the rotating partner token of a project
provider, the README levels and the end-to-end checks it specifies, and points the features guide row at the secrets
guide.
