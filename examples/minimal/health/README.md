# health

The smallest project that shows the `health` native: a liveness route, a readiness route checking the database, a `cache` check written in the config, and a `mail` project feature that adds a non-critical `mail.smtp` check.

```bash
bun run test
```

The health guide (`docs/src/content/docs/guides/health.md`, on the site at `/guides/health/`) explains every piece, with Kubernetes probe settings.

## Level 0: enable

Turn the native on; `GET /health/live` and `GET /health/ready` answer at once:

```ts
export default defineConfig({ database: memoryAdapter(), health: {} });
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable: the paths, each check's time limit, the cache, the details and the drain delay; `checks` adds the project's own checks:

```ts
health: { timeout: "1s", checks: { cache: async () => ({ entries: 3 }) } }
```

```bash
QS_HEALTH_DRAIN_DELAY=5s QS_HEALTH_READY=/ready bun .generated/server.ts
```

## Level 2: tags

Not applicable: the health routes are neither entities nor project endpoints, so no tag applies to them.

## Level 3: per request

`details` can be a function of the request: here only probes with the token see errors and extra fields, while the checks stay cached:

```ts
health: { details: ({ req }) => req?.headers.get("x-probe-token") === env.PROBE_TOKEN }
```

## Level 4: hooks and events

`beforeCheck` (returning `false` skips a check), `afterCheck` and `onStatusChange` run around the checks, and with `events: {}` a status change is the event `health.status.changed`:

```ts
health: {
  beforeCheck: (step) => (step && step.name === "queue" ? false : undefined),
  onStatusChange: ({ from, to }) => console.warn(`readiness ${from} -> ${to}`),
}
```

## Level 5: override files

A project endpoint at the path of a health route replaces it, and reads the checks with `runHealthChecks()`:

```ts
// endpoints/health/ready/get.ts
export default async (_repos: unknown, _req: unknown, res: ServiceResponse) => {
  const report = await runHealthChecks();
  res.status(report.status === "fail" ? 503 : 200);
  return { ready: report.status !== "fail" };
};
```

## Level 6: replace the implementation

`prober` replaces how the checks are run and combined; its `run` gets the registered checks and returns the ready response:

```ts
health: { prober: { run: async ({ checks }) => ({ status: "ok", checks: Object.fromEntries(checks.map((check) => [check.name, { status: "ok", durationMs: 0, critical: check.critical }])) }) } }
```

## Level 7: eject

Copy the native into the project as a `features/health/` project feature that replaces it:

```bash
quickservicets eject health
```
