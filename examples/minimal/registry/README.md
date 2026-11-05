# registry

The smallest project that shows the `registry` native: an `invoices` service whose `GET /invoices` calls the billing service through discovery, without a registry server. Two billing instances, 1.4.0 and 2.1.0, are listed as static services and served by `scripts/upstream.ts`; `discover: "billing@^2"` sends every call to the 2.x one, with retries on another instance.

```bash
bun run upstreams      # billing 1.4.0 on :4101 and 2.1.0 on :4102
bun run dev            # GET /invoices answers through 2.1.0
bun run test
```

`bun run test` checks round-robin across the instances, version selection with `^1` and `^2`, the ejection of a failing instance and its return, the 503 when no instance matches, DNS discovery with a test resolver, and registration with Consul answered by `http.mock()`; with `TEST_CONSUL_URL` set it also registers with a real Consul agent (otherwise that test is skipped by name). No registry server is needed.

## Level 0: enable

`registry: {}` registers through the static provider (it registers nothing) and lets the static services be discovered:

```ts
registry: { services: { billing: { instances: [{ url: "http://localhost:4101", version: "1.4.0" }, { url: "http://localhost:4102", version: "2.1.0" }] } } },
http: { services: { billing: { discover: "billing@^2", retry: true } } },
```

## Level 1: options and environment

Every option has its variable; a deployment switches a service's discovery, or the provider, without editing code:

```bash
QS_HTTP_SERVICES_BILLING_DISCOVER=billing@^1 bun run dev
QS_REGISTRY_PROVIDER=dns QS_REGISTRY_DNS_TEMPLATE='{name}.default.svc.cluster.local' QS_REGISTRY_DNS_PORT=8080 bun run dev
```

## Level 2: tags

Not applicable: discovery belongs to outgoing calls, not to entities, fields or endpoints.

## Level 3: per request

A per-tenant canary: `acme` calls the 3.x instances, every other tenant the 2.x ones:

```ts
http: { services: { billing: { discover: ({ tenant }) => (tenant?.id === "acme" ? "billing@^3" : "billing@^2") } } },
```

## Level 4: hooks and events

`onEjected` runs when a failing instance is taken out of rotation:

```ts
registry: { onEjected: ({ service, instance, until }) => console.warn(`${service}: ${instance.id} ejected until ${until.toISOString()}`) },
```

## Level 5: override files

Not applicable: the native contributes no files.

## Level 6: replace the implementation

`registryConsul()` of `providers/consul.ts` registers and resolves through a Consul agent (`docker compose --profile consul up -d` starts one), and a `balancer` replaces the strategy:

```ts
import { registryConsul } from "./providers/consul.ts";

registry: { name: "invoices", provider: registryConsul({ url: "http://localhost:8500" }) },
http: { allow: ["localhost"], services: { billing: { discover: "billing@^2", balancer: { pick: (instances) => instances[0]! } } } },
```

## Level 7: eject

```bash
bun run quickservicets eject registry
```

`features/registry/` then replaces the native, and the example's tests keep passing.
