import {
  anyOf,
  boolean,
  provider,
  resolveOption,
  runAfterHooks,
  runBeforeHooks,
  safeLog,
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
  type OptionSchema,
  type ServiceRequest,
} from "../public.ts";
import type { HealthApi, HealthCheckDone, HealthCheckEntry, HealthCheckFunction, HealthCheckInput, HealthCheckStep, HealthStatusChange } from "./api.ts";
import { cachedChecks, databaseCheck, readyBody, runChecks, type HealthCheck, type HealthProber, type HealthReport, type HealthStatus } from "./checks.ts";
import { sharedState } from "./state.ts";

const options = object({
  live: string().default("/health/live").describe("The path of the liveness route, which answers 200 while the process serves requests."),
  ready: string().default("/health/ready").describe("The path of the readiness route, which runs the checks."),
  timeout: duration().default("2s").describe("The time limit of each check."),
  cache: duration().default("1s").describe("How long a readiness result is reused by the probes of one worker; 0s runs the checks for every probe."),
  details: boolean()
    .optional()
    .perRequest()
    .describe("Shows each check's error and extra fields in the ready response; on outside production and off in production by default. A function of the request decides per request."),
  log: boolean().default(false).describe("Writes a request log entry for every probe; without it only 5xx responses of the health routes are logged."),
  drainDelay: duration()
    .optional()
    .describe("How long ready answers draining after a shutdown signal before the listener closes; 5s in production and 0s otherwise by default."),
  // Typed with the functions a project writes; at runtime each entry resolves to a list of functions or { check, critical }.
  checks: record(
    anyOf(hook<HealthCheckInput, undefined>(), object({ check: hook<HealthCheckInput, undefined>(), critical: boolean().default(true) })).describe(
      "A check: a function resolving (healthy, with extra fields) or throwing, or an object with check and critical false for a non-critical one.",
    ),
  ).describe("Readiness checks of the project by name, critical unless written as an object with critical false.") as unknown as ReturnType<typeof record<OptionSchema<HealthCheckEntry>>>,
  beforeCheck: hook<HealthCheckStep | false, undefined>().describe("Runs before each check with its name; returning false skips the check for that probe, reported as skipped."),
  afterCheck: hook<HealthCheckDone, undefined>().describe("Runs after each check with its name, status, duration and error."),
  onStatusChange: hook<HealthStatusChange, undefined>().describe("Runs when the overall readiness of this worker changes, with the old and new status and the checks; with events enabled the change is also the event health.status.changed."),
  prober: provider<HealthProber>("HealthProber", ["run"])
    .optional()
    .describe("Replaces how the checks are run and combined: its run method gets the registered checks and returns the ready response."),
});

/** The security items that would refuse probes. */
const EXEMPT_ITEMS = ["rateLimit", "loadShedding", "ip"] as const;

/** How check names are written. */
const CHECK_NAME = /^[a-z][a-z0-9-]*$/;

/** The registered checks of the running service, with who registered each; features add theirs during setup. */
const registry = sharedState("checks", () => ({
  checks: [] as (HealthCheck & { owner: string; key: string })[],
  open: false,
  /** Runs the checks of the running service, as the ready route does, without its cache. */
  run: undefined as (() => Promise<HealthReport>) | undefined,
}));

/** Runs the readiness checks of the running service, for a project endpoint that replaces the ready route. */
export function runHealthChecks(): Promise<HealthReport> {
  if (!registry.run) return Promise.reject(new Error("health is not enabled; add health: {} to quickservicets.config.ts"));
  return registry.run();
}

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
    for (const [name, resolved] of Object.entries(ctx.options.checks)) {
      const entry = resolved as unknown as HealthCheckFunction[] | { check: HealthCheckFunction[]; critical: boolean };
      const [fn, critical] = Array.isArray(entry) ? [entry, true] : [entry.check, entry.critical];
      register(name, "health.checks", { critical, timeout: ctx.options.timeout, run: (input) => runAll(fn as HealthCheckFunction[], input) });
    }

    const drainMs = parseDuration(drainDelayOf(ctx.options, ctx.config.production)) ?? 0;
    // Until every onStart ran, readiness answers starting; from the shutdown signal on, draining.
    let state: "starting" | "running" | "draining" = "starting";
    const unsubscribe = [onServiceStarted(() => state === "starting" && (state = "running")), onShutdownSignal(() => (state = "draining"))];
    const checks = () => registry.checks;
    const { beforeCheck, afterCheck, onStatusChange } = ctx.options;
    const hooks = {
      ...(beforeCheck.length > 0 ? { before: async (name: string) => (await runBeforeHooks(beforeCheck, { name } as HealthCheckStep | false, undefined)) !== false } : {}),
      ...(afterCheck.length > 0
        ? { after: (name: string, result: HealthReport["checks"][string]) => runAfterHooks(afterCheck, { name, status: result.status, durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) }, undefined) }
        : {}),
    };
    const prober = ctx.options.prober as HealthProber | undefined;
    // The overall status this worker reported last; a change runs onStatusChange and becomes an event.
    let lastStatus: HealthStatus | undefined;
    const eventsEnabled = ctx.config.features.some((feature) => feature.key === "events");
    const observe = async (report: HealthReport) => {
      const from = lastStatus;
      lastStatus = report.status;
      if (from === undefined || from === report.status) return report;
      if (onStatusChange.length > 0) await runAfterHooks(onStatusChange, { from, to: report.status, checks: report.checks }, undefined);
      if (eventsEnabled) {
        const failing = Object.entries(report.checks).filter(([, result]) => result.status === "fail").map(([name]) => name);
        try {
          await ctx.events.emit("health.status.changed", { from, to: report.status, failing });
        } catch (error) {
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "health.event.failed", error: { message: (error as Error)?.message ?? String(error) } });
        }
      }
      return report;
    };
    const run = async () => observe(prober ? await prober.run({ checks: checks() }) : await runChecks(checks(), ctx.logger, hooks));
    registry.run = run;
    const ready = cachedChecks(run, parseDuration(ctx.options.cache) ?? 1000);
    const detailsFor = async (req: ServiceRequest) => (await resolveOption(ctx.options.details, { req })) ?? !ctx.config.production;
    // The probes answer anonymous callers even when auth requires a user everywhere.
    const routeOptions = { log: ctx.options.log, auth: false };
    ctx.app.route("GET", ctx.options.live, () => ({ status: "ok" }), routeOptions);
    ctx.app.route(
      "GET",
      ctx.options.ready,
      async (_repos, req, res) => {
        if (state !== "running") {
          res.status(503);
          return { status: state };
        }
        const report = await ready();
        res.status(report.status === "fail" ? 503 : 200);
        return readyBody(report, await detailsFor(req));
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
      if (registry.run === run) registry.run = undefined;
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
    run: () => runHealthChecks(),
    addHook: ctx.addHook as HealthApi["addHook"],
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
export type { HealthApi, HealthCheckDone, HealthCheckEntry, HealthCheckFunction, HealthCheckInput, HealthCheckOptions, HealthCheckStep, HealthStatusChange, HealthStatusChangedEvent } from "./api.ts";
export type { HealthCheck, HealthCheckResult, HealthProber, HealthReport, HealthStatus } from "./checks.ts";
