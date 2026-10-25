import {
  anyOf,
  boolean,
  defineFeature,
  duration,
  hook,
  object,
  onServiceStarted,
  onShutdownSignal,
  parseDuration,
  record,
  string,
  type FeatureSetupContext,
} from "../public.ts";
import type { HealthApi, HealthCheckFunction, HealthCheckInput } from "./api.ts";
import { cachedChecks, databaseCheck, readyBody, runChecks, type HealthCheck } from "./checks.ts";
import { sharedState } from "./state.ts";

const options = object({
  live: string().default("/health/live").describe("The path of the liveness route, which answers 200 while the process serves requests."),
  ready: string().default("/health/ready").describe("The path of the readiness route, which runs the checks."),
  timeout: duration().default("2s").describe("The time limit of each check."),
  cache: duration().default("1s").describe("How long a readiness result is reused by the probes of one worker; 0s runs the checks for every probe."),
  details: boolean()
    .optional()
    .describe("Shows each check's error and extra fields in the ready response; on outside production and off in production by default."),
  log: boolean().default(false).describe("Writes a request log entry for every probe; without it only 5xx responses of the health routes are logged."),
  drainDelay: duration()
    .optional()
    .describe("How long ready answers draining after a shutdown signal before the listener closes; 5s in production and 0s otherwise by default."),
  checks: record(
    anyOf(hook<HealthCheckInput, undefined>(), object({ check: hook<HealthCheckInput, undefined>(), critical: boolean().default(true) })).describe(
      "A check: a function resolving (healthy, with extra fields) or throwing, or an object with check and critical false for a non-critical one.",
    ),
  ).describe("Readiness checks of the project by name, critical unless written as an object with critical false."),
});

/** The security items that would refuse probes. */
const EXEMPT_ITEMS = ["rateLimit", "loadShedding", "ip"] as const;

/** How check names are written. */
const CHECK_NAME = /^[a-z][a-z0-9-]*$/;

/** The registered checks of the running service, with who registered each; features add theirs during setup. */
const registry = sharedState("checks", () => ({ checks: [] as (HealthCheck & { owner: string; key: string })[], open: false }));

/** The default `drainDelay`: probes see `draining` for a while in production, where a load balancer needs the time. */
const drainDelayOf = (options: { drainDelay?: string }, production: boolean) => options.drainDelay ?? (production ? "5s" : "0s");

/** Adds a check, failing when its name is taken or not valid. */
function register(name: string, owner: string, check: Omit<HealthCheck, "name">, shownAs = name): void {
  if (!CHECK_NAME.test(name)) throw new Error(`Invalid health check ${name}: names match ${CHECK_NAME.source}`);
  const taken = registry.checks.find((entry) => entry.key === name);
  if (taken) throw new Error(`Health check ${name} is defined by ${taken.owner} and ${owner}`);
  registry.checks.push({ ...check, name: shownAs, key: name, owner });
}

/**
 * The `health` native: a liveness route that answers without touching anything, and a readiness route that runs the
 * database, queue, feature and project checks, cached, safe to expose and left out of the request log; it reports
 * `starting` until the service started and `draining` once a shutdown began. Off unless `health: {}` (or
 * `QS_HEALTH_ENABLED=true`) is set.
 */
const healthFeature = defineFeature({
  key: "health",
  docs: { summary: "Liveness and readiness routes for orchestrators and load balancers, checking the database, the queue and the checks features add." },
  options,
  after: ["security", "queues"],
  validate(options, config) {
    const lifecycle = config.lifecycle as { stopTimeout?: string } | undefined;
    const stopTimeout = lifecycle?.stopTimeout ?? "10s";
    const drainDelay = drainDelayOf(options, config.production === true);
    const stopMs = parseDuration(stopTimeout);
    return stopMs !== undefined && (parseDuration(drainDelay) ?? 0) > stopMs ? [`health.drainDelay (${drainDelay}) must be shorter than lifecycle.stopTimeout (${stopTimeout})`] : [];
  },
  setup(ctx) {
    const enabled = (key: string) => ctx.config.features.some((feature) => feature.key === key);
    registry.checks = [];
    registry.open = true;
    register("database", "health", { critical: true, timeout: ctx.options.timeout, run: databaseCheck(ctx.config.database, ctx.models) });
    if (enabled("queues")) {
      const queues = ctx.feature("queues");
      register("queue", "health", { critical: false, timeout: ctx.options.timeout, run: () => queues.health() });
    }
    for (const [name, entry] of Object.entries(ctx.options.checks)) {
      const [fn, critical] = Array.isArray(entry) ? [entry, true] : [(entry as { check: HealthCheckFunction[] }).check, (entry as { critical: boolean }).critical];
      register(name, "health.checks", { critical, timeout: ctx.options.timeout, run: (input) => runAll(fn as HealthCheckFunction[], input) });
    }

    const details = ctx.options.details ?? !ctx.config.production;
    const drainMs = parseDuration(drainDelayOf(ctx.options, ctx.config.production)) ?? 0;
    // Until every onStart ran, readiness answers starting; from the shutdown signal on, draining.
    let state: "starting" | "running" | "draining" = "starting";
    const unsubscribe = [onServiceStarted(() => state === "starting" && (state = "running")), onShutdownSignal(() => (state = "draining"))];
    const checks = () => registry.checks;
    const ready = cachedChecks(() => runChecks(checks(), ctx.logger), parseDuration(ctx.options.cache) ?? 1000);
    const routeOptions = { log: ctx.options.log };
    ctx.app.route("GET", ctx.options.live, () => ({ status: "ok" }), routeOptions);
    ctx.app.route(
      "GET",
      ctx.options.ready,
      async (_repos, _req, res) => {
        if (state !== "running") {
          res.status(503);
          return { status: state };
        }
        const report = await ready();
        res.status(report.status === "fail" ? 503 : 200);
        return readyBody(report, details);
      },
      routeOptions,
    );
    if (enabled("security")) exemptProbes(ctx);
    // Checks are registered during the setups; once the service starts the list is final.
    ctx.app.onStart(() => void (registry.open = false));
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    ctx.app.onShutdown(async () => {
      state = "draining";
      // The listener closes after this callback: load balancers see draining and stop sending traffic first.
      if (drainMs > 0) await new Promise<void>((resolve) => (drainTimer = setTimeout(resolve, drainMs)));
    });
    ctx.app.onStop(() => {
      clearTimeout(drainTimer);
      for (const off of unsubscribe) off();
      registry.open = false;
    });
  },
  api: (ctx): HealthApi => ({
    check(name, fn, options = {}) {
      const caller = ctx.currentFeature();
      if (!registry.open || !caller) throw new Error("health check() is only available during the setup of a feature");
      if (typeof fn !== "function") throw new Error(`Health check ${name} of ${caller} needs a function`);
      register(name, caller, { critical: options.critical ?? true, timeout: options.timeout ?? ctx.options.timeout, run: fn }, `${caller}.${name}`);
    },
  }),
});

/** Runs the functions of a config check in order, the last one's result giving the extra fields. */
async function runAll(fns: readonly HealthCheckFunction[], input: HealthCheckInput): Promise<unknown> {
  let result: unknown;
  for (const fn of fns) result = await fn(input, undefined);
  return result;
}

/** Keeps rate limits, load shedding and IP lists away from the probes. */
function exemptProbes(ctx: FeatureSetupContext<{ live: string; ready: string }>): void {
  const security = ctx.feature("security");
  const patterns = new Set(["/health/*", ctx.options.live, ctx.options.ready]);
  for (const pattern of patterns) security.exempt(pattern, EXEMPT_ITEMS);
}

export default healthFeature;
export { healthFeature };
export type { HealthApi, HealthCheckFunction, HealthCheckInput, HealthCheckOptions } from "./api.ts";
export type { HealthCheck, HealthCheckResult, HealthReport, HealthStatus } from "./checks.ts";
