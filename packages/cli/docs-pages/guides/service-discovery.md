# Service discovery

> Let each instance announce itself to a service registry when it is ready, keep its entry alive with heartbeats, and leave before it stops serving.

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

## Providers

The built-in provider `static` registers nothing: it suits services that know each other's addresses. A registry server plugs in as a `RegistryProvider`:

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
