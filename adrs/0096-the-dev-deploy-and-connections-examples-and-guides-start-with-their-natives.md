# 0096 - The `dev`, `deploy` and `connections` examples and guides start with their natives

- Date: 2026-11-04
- Spec: 0307-dev-services-compose-generation
- Status: accepted

## Context
The repository checks that every registered native has a complete minimal example (`examples/minimal/<key>`, spec 0158) and a row in the features guide linking to its guide and reference page. Spec 0307 registers the `dev` native, but its example and guide belong to spec 0309; the same happens to `deploy` (spec 0310, example and guide in 0319) and `connections` (spec 0320, example and guide in 0323). Without them the checks fail on the specs that add the natives.

## Options considered
- A: The spec that registers a native also adds a small example (README with every level, a config and a test) and a first version of its guide; the later example-and-guide spec completes both, as ADR 0084 did for `secrets`. Every commit keeps the checks green.
- B: Exempt the three natives from the checks until their example specs. Needs exemptions in tests that later must be removed.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- Spec 0307 adds `examples/minimal/dev` and `guides/local-environment.md`; spec 0309 completes them.
- Spec 0310 adds `examples/minimal/deploy` and `guides/deploy-targets.md`; spec 0319 completes them.
- Spec 0320 adds `examples/minimal/connections` and `guides/serverless-connections.md`; spec 0323 completes them.
