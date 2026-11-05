# 0101 - The `triggers` and `registry` examples and guides start with their natives

- Date: 2026-11-05
- Spec: 0324-trigger-files-and-sources
- Status: accepted

## Context
The repository checks that every registered native has a complete minimal example (`examples/minimal/<key>`, spec 0158) and a row in the features guide linking to its guide and reference page. Spec 0324 registers the `triggers` native, but its example and guide belong to spec 0330; spec 0332 registers the `registry` native, whose example and guide belong to spec 0338. Without them the checks fail on the specs that add the natives.

## Options considered
- A: The spec that registers a native also adds a small example (README with every level, a config and a test) and a first version of its guide; the later example-and-guide spec completes both, as ADR 0096 did for `dev`, `deploy` and `connections`. Every commit keeps the checks green.
- B: Exempt the two natives from the checks until their example specs. Needs exemptions in tests that later must be removed.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- Spec 0324 adds `examples/minimal/triggers` and `guides/cloud-triggers.md`; spec 0330 completes them.
- Spec 0332 adds `examples/minimal/registry` and `guides/service-discovery.md`; spec 0338 completes them.
