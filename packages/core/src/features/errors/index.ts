import {
  anyOf,
  defineFeature,
  HttpError,
  list,
  object,
  provider,
  record,
  safeLog,
  setErrorReportSink,
  string,
  type ErrorMiddleware,
  type ErrorReport,
  type ErrorReporter,
  type ErrorReportKind,
  type ErrorReportRequest,
  type Logger,
  type LogMasker,
  type ReportErrorExtra,
  type ServiceRequest,
} from "../public.ts";
import type { ErrorsApi } from "./api.ts";

const CONSOLE = Symbol.for("quickservice.errors.console");

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
  tags: record(string().describe("The value of the tag.")).describe("Tags added to every report, by name."),
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
export function reportDispatcher(settings: { reporters: () => readonly ErrorReporter[]; logger: Logger; mask?: () => LogMasker | undefined }) {
  const pending = new Set<Promise<unknown>>();
  const failed = (index: number, error: unknown) =>
    safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "error.report.failed", reporter: index, error: { message: (error as Error)?.message ?? String(error) } });
  return {
    send(report: ErrorReport) {
      const masker = settings.mask?.();
      const masked = masker ? masker.entry(report) : report;
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
    },
    /** The reports still being delivered. */
    pending: () => [...pending],
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
  // Reports are masked like the log when security masking is on.
  after: ["security"],
  setup(ctx) {
    consoleLogger = ctx.logger;
    const configured = (ctx.options.reporter as ErrorReporter | ErrorReporter[] | undefined) ?? consoleReporter();
    const reporters: ErrorReporter[] = [...(Array.isArray(configured) ? configured : [configured])];
    added.set(ctx.options, reporters);
    const production = ctx.config.production;
    const security = ctx.config.features.some((feature) => feature.key === "security") ? ctx.feature("security") : undefined;
    const dispatcher = reportDispatcher({ reporters: () => reporters, logger: ctx.logger, mask: () => security?.masker() });
    const build = (error: unknown, kind: ErrorReportKind, extra: ReportErrorExtra & { request?: ServiceRequest } = {}): ErrorReport => {
      const req = extra.request;
      const user = extra.user ?? idOf(req?.user);
      const tenant = extra.tenant ?? idOf(req?.tenant);
      return {
        error: errorOf(error, production),
        kind,
        ...(req ? { request: requestOf(req) } : {}),
        ...(user ? { user } : {}),
        ...(tenant ? { tenant } : {}),
        tags: { ...(ctx.options.tags as Record<string, string>), ...(extra.tags ?? {}) },
        environment: production ? "production" : "development",
        ...(ctx.options.release !== undefined ? { release: ctx.options.release } : {}),
        at: new Date(),
      };
    };
    const middleware: ErrorMiddleware = {
      stage: "error",
      order: -1000,
      run(error, { req }) {
        if (isUnexpected(error)) dispatcher.send(build(error, "request", req ? { request: req } : {}));
        return undefined;
      },
    };
    ctx.app.use(middleware);
    setErrorReportSink((error, extra) => dispatcher.send(build(error, "manual", extra)));
    ctx.app.onStop(() => {
      setErrorReportSink(undefined);
      consoleLogger = undefined;
    });
  },
  api: (ctx): ErrorsApi => ({
    addReporter(reporter) {
      if (typeof reporter?.report !== "function") throw new Error("errors addReporter() expects an ErrorReporter with a report method");
      added.get(ctx.options)!.push(reporter);
    },
  }),
});

/** The reporters of each running configuration, which features add to. */
const added = new WeakMap<object, ErrorReporter[]>();

export default errorsFeature;
export { errorsFeature };
export type { ErrorsApi } from "./api.ts";
