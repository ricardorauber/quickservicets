# registry

> Service registration and discovery: instances register when ready, keep their entry alive with heartbeats and leave before they stop serving.

Service registration and discovery: instances register when ready, keep their entry alive with heartbeats and leave before they stop serving.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
registry: {}
```

It is not enabled by default: turn it on with `registry: {}` or `QS_REGISTRY_ENABLED=true`, and off with `registry: false` or `QS_REGISTRY_ENABLED=false`.

**Runs after:** `health`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `registry.name` | `string` | — | `QS_REGISTRY_NAME` | no | The service name the instance registers under (default: deploy.name, then the package name without its scope). |
| `registry.version` | `string` | — | `QS_REGISTRY_VERSION` | no | The version the instance announces (default: the package version). |
| `registry.address` | `url` | — | `QS_REGISTRY_ADDRESS` | no | The base URL other services call the instance at (default: http with the machine's first non-loopback address and the server port). |
| `registry.metadata.<name>` | `record of string` | — | `QS_REGISTRY_METADATA_<NAME>` | no | A metadata value. |
| `registry.zone` | `string` | — | `QS_REGISTRY_ZONE` | no | The zone the instance runs in, preferred by callers in the same zone. |
| `registry.provider` | `"static" \| "dns"` | `"static"` | `QS_REGISTRY_PROVIDER` | no | The built-in provider: static (instances listed in services; registering does nothing) or dns (instances from DNS records). |
| `registry.services.<name>.instances` | `record of object[]` | — | `QS_REGISTRY_SERVICES_<NAME>_INSTANCES` | no | The service's instances. |
| `registry.dns.template` | `string` | `"{name}"` | `QS_REGISTRY_DNS_TEMPLATE` | no | The host name to query, with `{name}` replaced by the service name, like `{name}.default.svc.cluster.local`. |
| `registry.dns.records` | `"a" \| "srv"` | `"a"` | `QS_REGISTRY_DNS_RECORDS` | no | The records to look up: a (A and AAAA, one instance per address with port) or srv (one instance per target and port). |
| `registry.dns.port` | `integer` | — | `QS_REGISTRY_DNS_PORT` | no | The port of instances found by A and AAAA records, unless the template's host carries one. |
| `registry.dns.scheme` | `"http" \| "https"` | `"http"` | `QS_REGISTRY_DNS_SCHEME` | no | The scheme of the instances' addresses. |
| `registry.dns.refresh` | `duration` | `"30s"` | `QS_REGISTRY_DNS_REFRESH` | no | How long resolved instances are kept at least; a longer record TTL wins, and they are refreshed in the background. |
| `registry.register` | `boolean` | `true` | `QS_REGISTRY_REGISTER` | no | Registers the instance once it started, keeps it alive with heartbeats and deregisters it on shutdown. |
| `registry.heartbeat` | `duration` | `"10s"` | `QS_REGISTRY_HEARTBEAT` | no | How often the instance's entry is renewed with its status. |
| `registry.ttl` | `duration` | `"30s"` | `QS_REGISTRY_TTL` | no | How long a registry keeps the entry without a heartbeat. |
| `registry.enabled` | `boolean` | `true` | `QS_REGISTRY_ENABLED` | no | Turns the feature off when false. |
| `registry.database` | `string` | — | `QS_REGISTRY_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Feature API

Other features reach it with `ctx.feature("registry")` in their setup, listing `registry` in `requires` or `after`.

### `setProvider`

```ts
setProvider(provider: RegistryProvider): void;
```

Replaces the configured provider, from the setup of another feature; two features setting one fail naming both.

### `provider`

```ts
provider(): RegistryProvider;
```

The provider in effect, once every setup ran.

### `instance`

```ts
instance(): ServiceInstance;
```

This process's instance, as it registers.

## Registration

With `register: true`, the worker that runs scheduled work registers the instance after every `onStart` callback ran (once per process, whatever `server.workers`), sends a heartbeat every `heartbeat` with `passing` (or, while `health` is enabled, the readiness: `passing` for ok, `warning` for degraded, `critical` for fail), and deregisters as soon as the shutdown signal arrives, before draining, so callers stop sending traffic first.

The instance is `{ id, name, version?, address, status, zone?, metadata }`, with the id `<name>-<hostname>-<pid>`; `name` defaults to `deploy.name` or the package name, `version` to the package version, and `address` to `http://<first non-loopback address>:<port>`.

A failed registration, heartbeat or deregistration logs `registry.register.failed`, `registry.heartbeat.failed` or `registry.deregister.failed` with the provider and the reason; registration is retried with a delay from 1 second doubling to 30 seconds, and nothing fails startup or shutdown. While `health` is enabled, the non-critical check `registry` fails while the instance is not registered or its last heartbeat failed, with the provider's `health()` when it has one.

## Providers

`static` resolves a name from `services` (`{ instances: [{ url, version?, weight, zone?, metadata? }] }`), each instance `passing` with the id `<name>-<index>`; `dns` looks the name up with `dns.template` (`{name}` replaced, like `{name}.default.svc.cluster.local`): A and AAAA records give one instance per address with `dns.port` and `dns.scheme`, SRV records (`_http._tcp.<host>` unless the template starts with `_`) one per target and port with its weight. DNS instances have no version; results are kept for the larger of the records' TTL and `dns.refresh`, refreshed in the background, and a failed refresh keeps the previous instances and logs `registry.dns.failed` at most once a minute per name. Both register nothing. `QS_REGISTRY_SERVICES` sets the whole `services` record as JSON; `useTestResolver` of `@quickservicets/core/testing` answers A, AAAA and SRV lookups in tests.

A `RegistryProvider` has `register(instance)`, `heartbeat(instance, status)`, `deregister(instance)` and `resolve(name)` resolving `ServiceInstance[]`, plus the optional `watch(name, onChange)`, `health()` and `close()`. A feature listing `registry` in `requires`, `after` or `enables` sets one during its setup with `ctx.feature("registry").setProvider(provider)`, replacing `provider`; two features setting one fail startup naming both.
