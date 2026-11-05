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

See the [registry reference](/reference/features/registry/) for every option, and [examples/minimal/registry](https://github.com/ricardorauber/quickservicets/blob/main/examples/minimal/registry/README.md) for a project that runs without a registry server.
