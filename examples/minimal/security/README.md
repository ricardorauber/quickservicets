# security

The smallest project that shows the `security` native, which every service has without asking: its protections are separate items (`proxy`, `headers`, `files`, `cors`, `limits`, `timeouts`, `loadShedding`, `rateLimit`, `ip` and `masking`), each on by default, run in a fixed order before routing. A project feature exempts the load balancer's probe from the items that could refuse it.

```bash
bun run test
```

## Level 0: enable

Nothing to add: the native is enabled by default. `security: false` removes it all:

```ts
export default defineConfig({ database: memoryAdapter(), security: false });
```

## Level 1: options and environment

Each item is a switch; turn one off in the config or with its variable, and the whole feature with `QS_SECURITY_ENABLED=false`:

```ts
export default defineConfig({ database: memoryAdapter(), security: { cors: false } });
```

```bash
QS_SECURITY_CORS_ENABLED=false bun .generated/server.ts
```

## Level 2: tags

Not applicable: the items bring their tags with them; this version of the native has none yet.

## Level 3: per request

Not applicable: no option of this version is computed per request.

## Level 4: hooks and events

Not applicable: this version has no hook yet. A feature that runs after `security` can exempt paths from items in its setup:

```ts
export default defineFeature({
  key: "probes",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").exempt("/health/*", ["rateLimit", "loadShedding", "ip"]);
    ctx.app.route("GET", "/health/live", () => ({ status: "ok" }));
  },
});
```

## Level 5: override files

Not applicable: the native ships no endpoint, hook or job a project file could replace.

## Level 6: replace the implementation

Not applicable: this version has no provider option; a project feature with the key `security` replaces the whole native.

## Level 7: eject

Copy the native into the project as `features/security/`, which then replaces it:

```bash
bun run quickservice eject security
```
