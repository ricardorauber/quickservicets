# 0104 - The registry example ships its own small Consul provider

- Date: 2026-11-05
- Spec: 0338-registry-example-and-guide
- Status: accepted

## Context
Spec 0338 R1 and R3 show `registryConsul()` as an alternative provider of `examples/minimal/registry`, with a `consul` compose profile, a registration test through `http.mock()` and a container test with `TEST_CONSUL_URL`. The Consul provider plugin is a later spec of the plugin part (0679 to 0682), so no `registryConsul()` exists yet, and the minimal examples use no plugin.

## Options considered
- A: The example defines `registryConsul()` in `providers/consul.ts`: a small `RegistryProvider` over the Consul agent's HTTP API (register with a TTL check, check updates as heartbeats, deregister, health-filtered resolution), passed as the `provider` object of level 6. It shows how a project replaces the provider, the tests run it through `http.mock()` and against a real agent when `TEST_CONSUL_URL` is set, and the official plugin replaces it later.
- B: Leave Consul out of the example until the plugin exists. The example would miss R1's alternative and R3's Consul tests.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `examples/minimal/registry/providers/consul.ts` and `compose.yml` (profile `consul`) are part of the example; the guide points to the plugin for production use.
- When the Consul plugin lands, the example's level 6 can switch to it.
