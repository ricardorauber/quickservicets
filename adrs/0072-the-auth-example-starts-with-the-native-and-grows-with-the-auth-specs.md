# 0072 - The auth example starts with the native and grows with the auth specs

- Date: 2026-10-27
- Spec: 0245-auth-contract
- Status: accepted

## Context
Spec 0245 registers the `auth` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`, and the features guide must list every native. The auth example and guide are spec 0250, so the
checks would fail on specs 0245 to 0249.

## Options considered
- A: Add `examples/minimal/auth` with spec 0245, showing what exists at that point (a project-written API key
  provider registered by a project feature, `GET /me`, `testAuth()` in tests, eject) with `Not applicable:` lines for
  the levels later specs add, and a row in the features guide; spec 0250 brings both to their final content. ADRs
  0049 to 0071 chose this for the earlier natives.
- B: Let the checks skip natives without an example until a later spec: weakens spec 0158.
- C: Register the native only in spec 0250: breaks the specs that build and test it.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/auth` exists from spec 0245; the later auth specs keep it passing, and spec 0250 adds the
`providers` option, the tags, the hooks and the README levels it specifies.
