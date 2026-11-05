# registry

The smallest project that shows the `registry` native: an `invoices` service whose instance registers once it is ready, keeps its entry alive with heartbeats and deregisters before it stops serving.

```bash
bun run build
bun run test
```

`bun run test` starts the service and checks that its `registry` readiness check passes once the instance registered, without a registry server.

## Level 0: enable

`registry: {}` registers through the built-in `static` provider, which needs no server:

```ts
registry: {},
```

## Level 1: options and environment

Every option has its variable, like `QS_REGISTRY_NAME`, `QS_REGISTRY_ZONE` or `QS_REGISTRY_HEARTBEAT`:

```ts
registry: { name: "invoices", zone: "eu-1", heartbeat: "5s", metadata: { team: "billing" } },
```

```bash
QS_REGISTRY_ADDRESS=http://10.0.0.5:3000 bun run dev
QS_REGISTRY_PROVIDER=dns QS_REGISTRY_DNS_TEMPLATE='{name}.default.svc.cluster.local' QS_REGISTRY_DNS_PORT=8080 bun run dev
```

## Level 2: tags

Not applicable: discovery belongs to outgoing calls, not to entities, fields or endpoints.

## Level 3: per request

Not applicable: an instance registers once per process, not per request.

## Level 4: hooks and events

Not applicable: the native has no hooks yet; failures log `registry.register.failed`, `registry.heartbeat.failed` and `registry.deregister.failed`.

## Level 5: override files

Not applicable: the native contributes no files.

## Level 6: replace the implementation

A feature sets the provider of a registry server with `setProvider`:

```ts
setup(ctx) {
  ctx.feature("registry").setProvider({ register() {}, heartbeat() {}, deregister() {}, resolve: () => [] });
},
```

## Level 7: eject

```bash
bun run quickservicets eject registry
```

`features/registry/` then replaces the native, and the example's tests keep passing.
