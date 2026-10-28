# 0077 - The proxy example starts with the native and grows with the proxy specs

- Date: 2026-10-28
- Spec: 0266-proxy-routes
- Status: accepted

## Context
Spec 0266 registers the `proxy` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`, and the features guide must list every native with a guide link and a reference link. The proxy
example and the API gateway guide are spec 0269, so the checks would fail on specs 0266 to 0268.

## Options considered
- A: Add `examples/minimal/proxy` with spec 0266, showing what exists at that point (one route to a local catalog
  upstream, the route options and their variables, endpoint precedence, eject) with `Not applicable:` lines for the
  levels later specs add, and a row in the features guide linking the configuration guide until the API gateway guide
  exists; spec 0269 brings both to their final content. ADRs 0071, 0072 and 0075 chose this for earlier natives.
- B: Let the checks skip natives without an example until a later spec: weakens spec 0158.
- C: Register the native only in spec 0269: breaks the specs that build and test it.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/proxy` exists from spec 0266; specs 0267 and 0268 keep it passing, and spec 0269 adds the orders
upstream, identity forwarding, rate limits, authentication, the README levels and the end-to-end checks it specifies,
and points the features guide row at the API gateway guide.
