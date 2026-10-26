# Health checks

> Give Kubernetes and load balancers a liveness route and a readiness route that checks the database, the queue and your own dependencies, and shut down without dropping requests.

Orchestrators and load balancers need to know two things about each instance of a service: whether the process is alive (if not, restart it) and whether it can take traffic right now (if not, send requests elsewhere). The `health` native answers both with two routes that are cheap to call every few seconds, safe to expose, and left out of the request log. The options, variables, hooks, setup API and event are listed on the [health reference page](/reference/features/health/).

The samples come from the example project `examples/minimal/health`: a `cache` check written in the config, and a `mail` feature that adds a non-critical check for its mail server.

## Liveness and readiness

| Route | Answers | Use it for |
| --- | --- | --- |
| `GET /health/live` | `200 {"status":"ok"}` as long as the process serves requests; it touches nothing | the liveness probe: a failure restarts the instance |
| `GET /health/ready` | the result of every check: `200` when all pass (`ok`) or only non-critical ones fail (`degraded`), `503` when a critical one fails (`fail`) | the readiness probe and load balancer health checks: a failure only stops traffic |

Never point a liveness probe at readiness: a database outage would restart every instance at once, which fixes nothing.

## The checks

Readiness runs every check at once, each limited by `timeout` (default `2s`); a check that throws or runs out of time fails, with its error in the response outside production:

```json
{
  "status": "degraded",
  "checks": {
    "database": { "status": "ok", "durationMs": 0.412, "critical": true },
    "queue": { "status": "ok", "durationMs": 1.07, "critical": false, "waiting": 0, "oldestWaitingMs": null },
    "cache": { "status": "ok", "durationMs": 0.01, "critical": true, "entries": 3 },
    "mail.smtp": { "status": "fail", "durationMs": 0.02, "critical": false, "error": "SMTP server unreachable" }
  }
}
```

`database` is critical and uses the adapter's `ping` (`select 1` on SQLite and PostgreSQL, the `ping` command on MongoDB). With `queues: {}`, `queue` asks the broker; for the database broker it counts the waiting messages and the age of the oldest one. It is non-critical, so a slow queue degrades readiness instead of taking the instance out.

## Adding checks

The project adds checks by name in the config; each resolves (healthy, optionally with extra fields for its entry) or throws, and is critical unless written as `{ check, critical: false }`:

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  health: {
    checks: { cache: async () => ({ entries: 3 }) },
  },
  mail: {},
});
```

A feature adds its own from its setup with `ctx.feature("health").check(name, fn, options?)`, listing `health` in `after`; its checks are named `<key>.<name>`. A check receives a `signal` aborted at its timeout, to pass to `fetch` and other calls:

```ts title="features/mail/index.ts"
import { boolean, defineFeature, object } from "@quickservicets/core";

/** A small feature that adds a readiness check for its mail server. */
export default defineFeature({
  key: "mail",
  docs: { summary: "Adds the mail.smtp readiness check." },
  after: ["health"],
  options: object({
    down: boolean().default(false).describe("Makes the check fail as if the mail server were unreachable."),
  }),
  setup(ctx) {
    ctx.feature("health").check(
      "smtp",
      async () => {
        if (ctx.options.down) throw new Error("SMTP server unreachable");
        return { host: "smtp.example.com" };
      },
      { critical: false },
    );
  },
});
```

Names match `^[a-z][a-z0-9-]*$`; two checks with one name, or a project check named `database` or `queue`, fail the startup naming both owners.

## Caching

Each worker runs the checks at most once per `cache` (default `1s`): probes arriving within that time, concurrent ones included, share one result, so a hundred probes a second cost one database round trip. `cache: "0s"` runs the checks for every probe.

## Production details

In production the response leaves out each check's `error` and extra fields, which can reveal internals; every failure is still logged as `health.check.failed` with `check` and `error`. `details: true` shows them anyway, and `details` can be a function of the request, like `({ req }) => req?.headers.get("x-probe-token") === env.PROBE_TOKEN`, so only your own probes see them.

## Draining on shutdown

Until every feature's `onStart` ran, ready answers `503 {"status":"starting"}`. When the shutdown signal arrives, ready switches to `503 {"status":"draining"}` before anything else stops, and the native waits `drainDelay` (default `5s` in production, `0s` otherwise) before the listener closes, while every other route keeps serving. The load balancer sees the instance leave and stops sending it requests before it stops accepting them. `drainDelay` must be shorter than `lifecycle.stopTimeout` (default `10s`).

Recommended Kubernetes settings for the defaults:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 2
  timeoutSeconds: 3
  failureThreshold: 1
terminationGracePeriodSeconds: 30
```

The readiness timeout (`3`) stays above the check `timeout` (`2s`); a period of `2` with one failure takes the pod out of the endpoints well within the `5s` drain delay; and `30` seconds of grace cover the drain delay, the in-flight requests, `jobs.shutdownGrace` (`10s`) and the queue consumers' drain.

## Load balancers

Point the load balancer's health check at `/health/ready` with an interval of a few seconds and an unhealthy threshold of 1 or 2, so draining instances leave quickly; `degraded` answers 200 and keeps the instance in. Probes are exempt from rate limits, load shedding and IP lists of the `security` native, and they write no request log entry unless they fail with a 5xx (`log: true` logs every probe).

## Customization levels

| Level | How |
| --- | --- |
| Options and variables | `QS_HEALTH_LIVE`, `QS_HEALTH_READY`, `QS_HEALTH_TIMEOUT`, `QS_HEALTH_CACHE`, `QS_HEALTH_DETAILS`, `QS_HEALTH_LOG`, `QS_HEALTH_DRAIN_DELAY`, `QS_HEALTH_ENABLED` |
| Tags | Not applicable: the health routes are neither entities nor project endpoints |
| Per request | `details` as a function of the request |
| Hooks and events | `beforeCheck` (returning `false` skips a check, reported as `skipped`), `afterCheck`, `onStatusChange`; with `events: {}`, `health.status.changed` with `from`, `to` and the failing checks |
| Override files | A project endpoint at a health route's path, like `endpoints/health/ready/get.ts`, replaces it; `runHealthChecks()` runs the checks for it |
| Replace the implementation | `prober`: its `run` gets the registered checks and returns the ready response |
| Eject | `quickservicets eject health` |

## See also

- [Health reference](/reference/features/health/): every option with its variable, the hooks, the setup API and the event.
- [Configuration](/guides/configuration/): `lifecycle.stopTimeout` and the other shutdown limits.
- [Queues](/guides/queues/): the broker behind the `queue` check.
