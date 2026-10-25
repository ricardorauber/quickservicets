# health

The smallest project that shows the `health` native: a liveness route that answers without touching anything, and a readiness route that checks the database, cached for a second and left out of the request log.

```bash
bun run test
```

## Level 0: enable

Turn the native on; `GET /health/live` and `GET /health/ready` answer at once:

```ts
export default defineConfig({ database: memoryAdapter(), health: {} });
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable, like the paths, the time limit of each check and the cache:

```ts
health: { ready: "/ready", timeout: "1s", cache: "0s" }
```

```bash
QS_HEALTH_TIMEOUT=1s bun .generated/server.ts
```

## Level 2: tags

Not applicable: the health routes are neither entities nor project endpoints, so no tag applies to them.

## Level 3: per request

Not applicable: no health option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: the example replaces no health route yet.

## Level 6: replace the implementation

Not applicable: the checks are run and combined by the native only so far.

## Level 7: eject

Copy the native into the project as a `features/health/` project feature that replaces it:

```bash
quickservice eject health
```
