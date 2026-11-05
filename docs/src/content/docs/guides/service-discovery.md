---
title: Service discovery
description: Let each instance announce itself to a service registry when it is ready, keep its entry alive with heartbeats, and leave before it stops serving.
sidebar:
  order: 67
---

A service that runs as several instances, on hosts whose addresses change, needs a place where callers find them. The `registry` native lets each instance announce itself to a service registry when it is ready (its name, version, address, status and metadata), keeps its entry alive with heartbeats, and removes it before the instance stops serving.

The native is off until you turn it on:

```ts
registry: { name: "invoices", metadata: { team: "billing" } },
```

## Registration

With `register: true` (the default), the worker that runs scheduled work registers the instance once every `onStart` callback ran, so callers never reach an instance that is still starting. It registers once per process, whatever `server.workers` is. The instance is:

| Field | Value |
| --- | --- |
| `id` | `<name>-<hostname>-<pid>` |
| `name` | `registry.name`, else `deploy.name`, else the package name without its scope |
| `version` | `registry.version`, else the package version |
| `address` | `registry.address`, else `http://<first non-loopback address>:<port>` |
| `status` | `passing`, `warning` or `critical` |
| `zone` | `registry.zone` |
| `metadata` | `registry.metadata` |

## Heartbeats and draining order

Every `heartbeat` (default `10s`) the instance renews its entry, which the registry keeps for `ttl` (default `30s`) without one. The status is `passing`, or, while the `health` native is enabled, the readiness result: `passing` for ok, `warning` for degraded and `critical` for fail, so a registry stops sending traffic to an instance whose database is down.

On a shutdown signal the instance deregisters first, before the ready route starts answering `draining` and before the listener closes, so callers stop sending traffic before the instance stops serving.

## Failures

A failed registration, heartbeat or deregistration logs `registry.register.failed`, `registry.heartbeat.failed` or `registry.deregister.failed` with the provider and the reason. Registration is retried after 1 second, doubling up to 30 seconds; nothing fails startup or shutdown. While `health` is enabled, the non-critical check `registry` fails while the instance is not registered or its last heartbeat failed, with the provider's own `health()` when it has one.

## Choosing a provider

| Provider | Use it for |
| --- | --- |
| `static` | Small setups whose instances rarely change: the instances are listed in the config, and nothing registers |
| `dns` | Kubernetes, where a headless Service publishes every pod's address, and any platform with SRV records |
| Consul | Fleets with a Consul agent per host: registration with TTL checks, health-filtered resolution and watches |
| etcd | Platforms that already keep their configuration in etcd: leases as TTLs, watches on prefixes |
| Eureka | Spring Cloud estates, where other services already register with Eureka |
| Cloud Map | AWS, where ECS and Lambda services register in AWS Cloud Map |

`static` and `dns` are built in. Consul, etcd, Eureka and Cloud Map come as provider packages that set their `RegistryProvider` with `setProvider`; until one is installed, a project passes its own provider object, like the small `registryConsul()` of [examples/minimal/registry](https://github.com/ricardorauber/quickservicets/blob/main/examples/minimal/registry/README.md).

## Static services

The built-in provider `static` registers nothing and resolves each service from the config, which suits small setups whose addresses rarely change:

```ts
registry: {
  services: {
    billing: { instances: [{ url: "http://10.0.0.5:8080", version: "2.1.0" }, { url: "http://10.0.0.6:8080", version: "1.4.0", weight: 2, zone: "b" }] },
  },
},
```

Each instance is `passing`, with the id `<name>-<index>`, its `version`, `weight` (default 1), `zone` and `metadata`. `QS_REGISTRY_SERVICES` sets the whole record as JSON, like `QS_REGISTRY_SERVICES='{"billing":{"instances":[{"url":"http://b:80"}]}}'`.

## DNS

The built-in provider `dns` finds instances in DNS, as Kubernetes headless services and SRV records publish them, without a registry server:

```ts
registry: { provider: "dns", dns: { template: "{name}.default.svc.cluster.local", port: 8080 } },
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dns.template` | `{name}` | The host name to query, `{name}` replaced by the service name |
| `dns.records` | `a` | `a`: A and AAAA records, one instance per address with `dns.port`; `srv`: SRV records (`_http._tcp.<host>` unless the template starts with `_`), one instance per target and port, with the record's weight |
| `dns.port` | — | The port of A and AAAA instances, required unless the template's host carries one |
| `dns.scheme` | `http` | The scheme of the addresses |
| `dns.refresh` | `30s` | The least time results are kept |

Results are kept per name for the larger of the records' TTL and `dns.refresh` and refreshed in the background before they expire; a failed refresh keeps the previous instances and logs `registry.dns.failed` at most once a minute per name. DNS instances have no version. Each option has its variable: `QS_REGISTRY_PROVIDER=dns`, `QS_REGISTRY_DNS_TEMPLATE`, `QS_REGISTRY_DNS_RECORDS`, `QS_REGISTRY_DNS_PORT` and `QS_REGISTRY_DNS_REFRESH`. In tests, `useTestResolver` of `@quickservicets/core/testing` answers the lookups, SRV answers included:

```ts
useTestResolver({ "_http._tcp.billing": { srv: [{ name: "billing-0.billing", port: 8080, weight: 1, priority: 0 }] } });
```

## Discovered services and balancing

A caller finds a service's instances with `discover` in `http.services`:

```ts
registry: { services: { billing: { instances: [{ url: "http://10.0.0.5:8080" }, { url: "http://10.0.0.6:8080" }] } } },
http: { services: { billing: { discover: { name: "billing", balance: "round-robin", preferZone: true }, retry: true } } },
```

```ts
const invoices = await req.http.service("billing").get("/invoices").send();
```

Calls resolve the instances through the provider, cached for 5 seconds per worker and updated at once by `watch` when the provider offers it, skip `critical` instances and pick one per attempt:

| `balance` | Picks |
| --- | --- |
| `round-robin` | The instances in turn |
| `least-connections` | The instance with the fewest calls in flight in this worker |
| `random` | An instance at random, weighted by its `weight` |

With `preferZone` (the default) and a `registry.zone`, instances of the same zone are picked first while one of them is available. A retry of the service's `retry` modifier goes to a different instance when there is one, and the `http.call` entries carry the `instance` id. The picked instance's address is the base URL of the call and is trusted by SSRF protection like a service's own host, except the cloud metadata addresses `169.254.169.254` and `fd00:ec2::254`, which stay blocked. Without an available instance the call rejects with `NO_INSTANCES` and `No instances of <name>`, answered 503 `SERVICE_UNAVAILABLE` `Upstream unavailable` with `Retry-After: 5`. Proxy routes with `service` balance across the instances of a discovered service with no further option.

## Versions and canaries

A caller can call only the instances whose version satisfies a semantic version range, so old and new versions run side by side during an upgrade:

```ts
http: { services: { billing: { discover: "billing@^2" } } },
```

`discover` takes `name@range` (`billing@^2`, `billing@~2.3`, `billing@>=2.1 <3`), or the object form with `version`, checked at startup: `billing@banana` fails with `Invalid http.services.billing.discover: banana is not a version range`. Only instances whose version satisfies the range (Bun's `semver` rules) are candidates; instances without a version, like DNS ones, are left out unless `allowUnversioned: true`. `prefer: "any"` (the default) spreads calls over every matching instance, and `prefer: "highest"` over only those of the highest matching version. When instances exist but none matches, the call rejects with `NO_INSTANCES` and `No instances of billing match ^4 (found 1.4.0, 2.1.0, 2.3.0)`, listing at most ten versions, answered 503 like any call without an instance.

An instance announces `registry.version`, by default the package version; `QS_REGISTRY_VERSION` sets it at deployment, like a build number, without changing `package.json`.

## The API gateway

Proxy routes with `service` use the service's discovery with no further option, so a gateway balances across the instances, ejects failing ones and honors version ranges:

```ts
http: { services: { billing: { discover: "billing@^2" } } },
proxy: { routes: { billing: { path: "/billing/*", service: "billing" } } },
```

## SSRF trust

The picked instance's address is the base URL of each attempt, and SSRF protection trusts it like a service's own host, so discovered instances on private networks are reachable. The cloud metadata addresses `169.254.169.254` and `fd00:ec2::254` stay blocked even when a registry lists them.

## Ejection and panic

Each discovered service takes failing instances out of rotation in the worker that sees the failures, with `outlier` (on by default):

```ts
http: { services: { billing: { discover: "billing", outlier: { failures: 5, ejection: "30s", maxEjection: "5m", maxEjectedPercent: 50 } } } },
```

After `failures` failed attempts in a row (5xx answers, `NETWORK` and `TIMEOUT`, never 4xx), an instance is ejected for `ejection`, doubled for each further ejection up to `maxEjection`. It returns after its ejection time; its next failure ejects it again and its next success resets the count. No more than `maxEjectedPercent` of a service's instances are ejected at once (rounded down, at least one kept). When every remaining instance is ejected or `critical`, calls use all known instances and log `registry.panic` at most once a minute, because sending to possibly failing instances beats failing every call. Ejections log `registry.instance.ejected` with `service`, `instance`, `failures` and `until`, and returns log `registry.instance.restored`.

`http.state("billing").instances` lists the instances this worker knows: `{ id, address, state: "ok" | "ejected" | "critical", inFlight, failures, ejectedUntil? }`.

## Active probes

With `probe`, the worker that runs scheduled work requests each instance's probe path every `interval`:

```ts
http: { services: { billing: { discover: "billing", probe: { path: "/health/ready", interval: "10s", timeout: "2s" } } } },
```

A non-2xx answer or an error counts as a failure and a success as recovery, so an instance whose ready route answers 503 is ejected before any call fails. The results are kept by the probing process, which every call of that process reads; with several workers, the other workers learn of failing instances from their own calls.

## Providers

A registry server plugs in as a `RegistryProvider`:

```ts
interface RegistryProvider {
  register(instance: ServiceInstance): Promise<void> | void;
  heartbeat(instance: ServiceInstance, status: "passing" | "warning" | "critical"): Promise<void> | void;
  deregister(instance: ServiceInstance): Promise<void> | void;
  resolve(name: string): Promise<ServiceInstance[]> | ServiceInstance[];
  watch?(name: string, onChange: (instances: ServiceInstance[]) => void): (() => void) | Promise<() => void>;
  health?(): unknown;
}
```

A feature that lists `registry` in `requires`, `after` or `enables` sets it during its setup with `ctx.feature("registry").setProvider(provider)`; two features setting one fail startup naming both.

Without the native, no registration, timer or resolution exists.

## Customization levels

| Level | Service discovery |
| --- | --- |
| 0. Enable | `registry: {}` registers through the static provider (a no-op) and lets the static `services` be discovered |
| 1. Options and environment | Every option has its variable: `QS_REGISTRY_NAME`, `QS_REGISTRY_VERSION`, `QS_REGISTRY_ADDRESS`, `QS_REGISTRY_ZONE`, `QS_REGISTRY_PROVIDER`, `QS_REGISTRY_REGISTER`, `QS_REGISTRY_HEARTBEAT`, `QS_REGISTRY_TTL`, `QS_REGISTRY_SERVICES`, and per service `QS_HTTP_SERVICES_<NAME>_DISCOVER` |
| 2. Tags | Not applicable: discovery belongs to outgoing calls, not to entities, fields or endpoints |
| 3. Per request | `discover: ({ req, user, tenant }) => …`, evaluated for each call through `req.http` |
| 4. Hooks and events | `beforeRegister`, `onInstanceUp`, `onInstanceDown` and `onEjected`, and `ctx.feature("registry").addHook` |
| 5. Override files | Not applicable: the native contributes no files |
| 6. Replace the implementation | `provider` takes a `RegistryProvider` object (or a feature's `setProvider`), and each service a `balancer` |
| 7. Eject | `quickservicets eject registry` copies the native into `features/registry/` |

A canary sends chosen tenants to the new major version while the others keep the old one:

```ts
http: { services: { billing: { discover: ({ tenant }) => (tenant?.id === "acme" ? "billing@^3" : "billing@^2") } } },
```

A balancer replaces the strategy: `pick(instances, request)` returns one of the attempt's candidates.

```ts
http: { services: { billing: { discover: "billing", balancer: { pick: (instances) => instances[0]! } } } },
```

Provider authors check their provider with `runRegistryProviderContract(create, { fixtures })` of `@quickservicets/core/testing`.

See the [registry reference](/reference/features/registry/) for every option, and [examples/minimal/registry](https://github.com/ricardorauber/quickservicets/blob/main/examples/minimal/registry/README.md) for a project that runs without a registry server.
