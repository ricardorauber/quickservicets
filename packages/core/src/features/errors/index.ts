import {
  currentOperation,
  anyOf,
  defineFeature,
  HttpError,
  hook,
  list,
  number,
  object,
  observeJobRuns,
  oneOf,
  parseDuration,
  provider,
  record,
  resolveOption,
  safeLog,
  setErrorReportSink,
  setFailureSinks,
  string,
  type ErrorMiddleware,
  type ErrorReport,
  type ErrorReporter,
  type ErrorReportKind,
  type ErrorReportRequest,
  type FailureDetails,
  type Logger,
  type LogMasker,
  type ReportErrorExtra,
  type ServiceRequest,
} from "../public.ts";
import type { ErrorsApi } from "./api.ts";

const CONSOLE = Symbol.for("quickservicets.errors.console");

/** The logger console reporters write to: the configured one of the running service. */
let consoleLogger: Logger | undefined;

/**
 * The default reporter: one `error` log entry named `error.report` per report, with the report's fields, through the
 * configured logger.
 */
export function consoleReporter(): ErrorReporter {
  return {
    [CONSOLE]: true,
    report(report: ErrorReport) {
      if (consoleLogger) safeLog(consoleLogger, "error", { timestamp: report.at.toISOString(), message: "error.report", ...report, at: report.at.toISOString() });
    },
  } as ErrorReporter;
}

const reporterSchema = provider<ErrorReporter>("ErrorReporter", ["report"]);

const options = object({
  reporter: anyOf(reporterSchema, list(reporterSchema))
    .optional()
    .describe("Receives every report: one reporter or a list, each an object with report(report) and an optional flush(timeoutMs); without it, consoleReporter() writes error.report log entries."),
  release: string().optional().describe("The release of the service added to every report, like a version or a commit."),
  tags: record(string().describe("The value of the tag."))
    .perRequest()
    .describe("Tags added to every report, by name; a function of the request, its user and tenant computes them for request reports."),
  sampleRate: number()
    .min(0)
    .max(1)
    .default(1)
    .describe("The probability each report is sent, decided once per report; startup reports are always sent."),
  ignore: list(string())
    .default([])
    .describe("Error names, like AbortError, and response statuses, like 503, whose reports are dropped before sampling."),
  beforeReport: hook<ErrorReport | null, undefined>().describe(
    "Runs on each report after masking and before the reporters; it returns a changed report, or null to drop it, and a throw is logged and drops nothing.",
  ),
  jobs: oneOf(["final", "every"])
    .default("final")
    .describe("Which failed job runs and queue attempts are reported: final reports a run only when no retry follows, every reports each failed attempt."),
});

/** The headers a request report keeps. */
const KEPT_HEADERS = ["user-agent", "content-type", "referer"];

/** The id of a user or tenant, when it has one. */
const idOf = (value: unknown): { id: string } | undefined => {
  const id = (value as { id?: unknown } | undefined)?.id;
  return id === undefined || id === null ? undefined : { id: String(id) };
};

/** What a report says about a request: its id, method, path, route, three safe headers and the query. */
export function requestOf(req: ServiceRequest): ErrorReportRequest {
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { id: req.id, method: req.method, path: req.path, route: req.route ?? null, headers, query: Object.fromEntries(req.query) };
}

/** The error part of a report, without the stack in production. */
export function errorOf(error: unknown, production: boolean): ErrorReport["error"] {
  const failure = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error) ?? String(error));
  return { name: failure.name, message: failure.message, ...(!production && failure.stack ? { stack: failure.stack } : {}) };
}

/** Whether a request error is unexpected: anything but an HttpError below 500. */
export const isUnexpected = (error: unknown) => !(error instanceof HttpError) || error.status >= 500;

/** Sends reports to reporters without blocking: each failure is logged with the reporter's index, the others still get it. */
export function reportDispatcher(settings: {
  reporters: () => readonly ErrorReporter[];
  logger: Logger;
  mask?: () => LogMasker | undefined;
  /** The `beforeReport` hooks, run in order on the masked report. */
  beforeReport?: readonly ((report: ErrorReport | null, ctx: undefined) => unknown)[];
}) {
  const pending = new Set<Promise<unknown>>();
  const failed = (index: number, error: unknown) =>
    safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "error.report.failed", reporter: index, error: { message: (error as Error)?.message ?? String(error) } });
  const deliver = (masked: ErrorReport) =>
    settings.reporters().forEach((reporter, index) => {
      try {
        const result = reporter.report(masked);
        if (result instanceof Promise) {
          const tracked = result.catch((error: unknown) => failed(index, error)).finally(() => pending.delete(tracked));
          pending.add(tracked);
        }
      } catch (error) {
        failed(index, error);
      }
    });
  return {
    send(report: ErrorReport) {
      const masker = settings.mask?.();
      const masked = masker ? masker.entry(report) : report;
      const hooks = settings.beforeReport ?? [];
      if (hooks.length === 0) return deliver(masked);
      // The hooks may be asynchronous; the caller never waits for them.
      const tracked: Promise<unknown> = (async () => {
        let current: ErrorReport = masked;
        for (const fn of hooks) {
          try {
            const result = await fn(current, undefined);
            if (result === null) return;
            if (result !== undefined) current = result as ErrorReport;
          } catch (error) {
            safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "feature.hook.failed", feature: "errors", hook: "beforeReport", error: { message: (error as Error)?.message ?? String(error) } });
          }
        }
        deliver(current);
      })().finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    /** The reports still being delivered. */
    pending: () => [...pending],
    /**
     * Waits for the pending reports, then calls `flush` of each reporter that has one, all within `budgetMs`; resolves
     * false when the budget ran out.
     */
    async flush(budgetMs: number): Promise<boolean> {
      const deadline = Date.now() + budgetMs;
      const within = async (work: Promise<unknown>): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const left = Math.max(0, deadline - Date.now());
        const finished = await Promise.race([work.then(() => true, () => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), left)))]);
        clearTimeout(timer);
        return finished;
      };
      if (!(await within(Promise.allSettled([...pending])))) return false;
      for (const [index, reporter] of settings.reporters().entries()) {
        if (!reporter.flush) continue;
        let flushing: Promise<unknown>;
        try {
          flushing = Promise.resolve(reporter.flush(Math.max(0, deadline - Date.now())));
        } catch (error) {
          failed(index, error);
          continue;
        }
        if (!(await within(flushing.catch((error: unknown) => failed(index, error))))) return false;
      }
      return true;
    },
  };
}

/**
 * The `errors` native: every unexpected error of a request, and every error code reports with `reportError`, reaches
 * the configured reporters with its request, user and tenant, masked. Off unless `errors: {}` (or
 * `QS_ERRORS_ENABLED=true`) is set.
 */
const errorsFeature = defineFeature({
  key: "errors",
  docs: { summary: "One interface that receives every unexpected error with its request, user and tenant, so a reporting service plugs in with one line." },
  options,
  tags: {
    report: {
      on: ["entity", "endpoint"],
      options: ["sampleRate"],
      description: "`@report off` stops the request reports of the endpoint or of the entity's routes, and `@report sampleRate=0.1` sets their sampling rate.",
      example: "/** @report sampleRate=0.1 */\nexport default () => ({ ok: true });",
    },
  },
  // Reports are masked like the log when security masking is on, and cover queue messages and events when they run.
  after: ["security", "queues", "events"],
  setup(ctx) {
    consoleLogger = ctx.logger;
    const configured = (ctx.options.reporter as ErrorReporter | ErrorReporter[] | undefined) ?? consoleReporter();
    const reporters: ErrorReporter[] = [...(Array.isArray(configured) ? configured : [configured])];
    added.set(ctx.options, reporters);
    const production = ctx.config.production;
    const security = ctx.config.features.some((feature) => feature.key === "security") ? ctx.feature("security") : undefined;
    const dispatcher = reportDispatcher({ reporters: () => reporters, logger: ctx.logger, mask: () => security?.masker(), beforeReport: ctx.options.beforeReport as never });
    const ignored = new Set(ctx.options.ignore);
    /** Sends a report unless its error name or status is ignored, or sampling leaves it out; startup reports always go. */
    const submit = (report: ErrorReport, settings: { status?: number; sampleRate?: number } = {}) => {
      if (ignored.has(report.error.name) || (settings.status !== undefined && ignored.has(String(settings.status)))) return;
      const rate = settings.sampleRate ?? ctx.options.sampleRate;
      if (report.kind !== "startup" && !(randomSource() < rate)) return;
      dispatcher.send(report);
    };
    /** The static tags; a tags function applies to request reports only. */
    const staticTags = typeof ctx.options.tags === "function" ? {} : (ctx.options.tags as Record<string, string>);
    const build = (error: unknown, kind: ErrorReportKind, extra: ReportErrorExtra & Omit<Partial<FailureDetails>, "kind"> = {}): ErrorReport => {
      const req = extra.request;
      const user = extra.user ?? idOf(req?.user);
      const tenant = extra.tenant ?? idOf(req?.tenant);
      const scope = currentOperation()?.scope;
      return {
        error: errorOf(error, production),
        kind,
        ...(req ? { request: requestOf(req) } : {}),
        ...(user ? { user } : {}),
        ...(tenant ? { tenant } : {}),
        ...(extra.job ? { job: extra.job } : {}),
        ...(extra.queue ? { queue: extra.queue } : {}),
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
        ...(scope ? { scope } : {}),
        tags: { ...staticTags, ...(extra.tags ?? {}) },
        environment: production ? "production" : "development",
        ...(ctx.options.release !== undefined ? { release: ctx.options.release } : {}),
        at: new Date(),
      };
    };
    const middleware: ErrorMiddleware = {
      stage: "error",
      order: -1000,
      async run(error, { req }) {
        if (!isUnexpected(error)) return undefined;
        // `@report off` on the route's endpoint or entity stops its reports, and `@report sampleRate=` sets their rate.
        const route = req ? errorsFeature.optionsFor(req) : undefined;
        if (route?.on === false) return undefined;
        let tags: Record<string, string> = {};
        if (req && typeof ctx.options.tags === "function") {
          try {
            tags = ((await resolveOption(ctx.options.tags, { req })) as Record<string, string> | undefined) ?? {};
          } catch (failure) {
            safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "error.tags.failed", requestId: req.id, error: { message: (failure as Error)?.message ?? String(failure) } });
          }
        }
        const status = error instanceof HttpError ? error.status : 500;
        submit(build(error, "request", { ...(req ? { request: req } : {}), tags }), { status, ...(route ? { sampleRate: route.sampleRate } : {}) });
        return undefined;
      },
    };
    ctx.app.use(middleware);
    const stopTimeout = parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000;
    const flush = async (budgetMs: number) => {
      if (!(await dispatcher.flush(budgetMs))) safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "error.flush.timeout", timeoutMs: budgetMs });
    };
    const failures = (error: unknown, details: FailureDetails) => submit(build(error, details.kind, details));
    // A later feature failing to start is reported from now on; the rest once the service started.
    const startup = async (error: unknown, details: { feature?: string; phase?: string }) => {
      submit(build(error, "startup", { tags: { ...(details.feature ? { feature: details.feature } : {}), ...(details.phase ? { phase: details.phase } : {}) } }));
      await flush(stopTimeout);
    };
    setFailureSinks(undefined, startup);
    // Failed job runs: only those no retry follows, or every failed attempt.
    const every = ctx.options.jobs === "every";
    let stopObserving = () => {};
    ctx.app.onStart(() => {
      setErrorReportSink((error, extra) => submit(build(error, "manual", extra)));
      setFailureSinks(failures, startup);
      stopObserving = observeJobRuns(onJobRun);
    });
    const onJobRun = (run: Parameters<Parameters<typeof observeJobRuns>[0]>[0]) => {
      if (run.status !== "failed" && run.status !== "timedOut" && run.status !== "abandoned") return;
      if (!every && run.willRetry) return;
      const failure = Object.assign(new Error(run.error?.message ?? `Job ${run.job} ended ${run.status}`), { stack: run.error?.stack });
      if (!run.error?.stack) delete (failure as { stack?: string }).stack;
      submit(build(failure, "job", { job: { name: run.job, runId: run.runId, attempt: run.attempt } }));
    };
    // Dead queue messages, and with every each failed attempt, with the user and tenant of the request that added them.
    if (ctx.config.features.some((feature) => feature.key === "queues")) {
      const queues = ctx.feature("queues");
      const fromMessage = (message: { queue: string; id: string; attempt: number; requestId?: string; actor?: { user?: string; tenant?: string } }) => ({
        queue: { name: message.queue, messageId: message.id, attempt: message.attempt },
        ...(message.actor?.user !== undefined ? { user: { id: message.actor.user } } : {}),
        ...(message.actor?.tenant !== undefined ? { tenant: { id: message.actor.tenant } } : {}),
        ...(message.requestId ? { requestId: message.requestId } : {}),
      });
      queues.addHook("onDead", ({ message, error }) => void submit(build(error, "queue", fromMessage(message))));
      if (every) queues.addHook("afterProcess", ({ message, status, error }) => void (status === "failed" && submit(build(error, "queue", fromMessage(message)))));
    }
    // On shutdown, the pending reports and the reporters' own buffers are delivered within the stop timeout.
    ctx.app.onStop(async () => {
      stopObserving();
      setErrorReportSink(undefined);
      setFailureSinks(undefined, undefined);
      await flush(Math.floor(stopTimeout * 0.9));
      consoleLogger = undefined;
    });
  },
  api: (ctx): ErrorsApi => ({
    beforeReport: (fn) => ctx.addHook("beforeReport", fn as never),
    addReporter(reporter) {
      if (typeof reporter?.report !== "function") throw new Error("errors addReporter() expects an ErrorReporter with a report method");
      added.get(ctx.options)!.push(reporter);
    },
  }),
});

/** Where sampling draws its numbers; tests replace it to make sampling predictable. */
let randomSource: () => number = Math.random;

/** Replaces the random source of sampling (`Math.random` when undefined), for tests. */
export function setSamplingRandom(source: (() => number) | undefined): void {
  randomSource = source ?? Math.random;
}

/** The reporters of each running configuration, which features add to. */
const added = new WeakMap<object, ErrorReporter[]>();

export default errorsFeature;
export { errorsFeature };
export type { ErrorsApi } from "./api.ts";
