import type { ServiceRequest } from "./hooks.ts";

/** What kind of code an error came from. */
export type ErrorReportKind = "request" | "job" | "queue" | "startup" | "event" | "manual";

/** The request an error happened in, without its body, cookies or `authorization` header. */
export interface ErrorReportRequest {
  id: string;
  method: string;
  path: string;
  /** The matched route, like `/users/[id]`, or null when none matched. */
  route: string | null;
  /** Only `user-agent`, `content-type` and `referer`. */
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** One unexpected error, as reporters receive it. */
export interface ErrorReport {
  error: { name: string; message: string; stack?: string };
  kind: ErrorReportKind;
  request?: ErrorReportRequest;
  user?: { id: string };
  tenant?: { id: string };
  /** The caller's client certificate (`req.client`), when the request had one. */
  client?: { commonName?: string; fingerprint256: string };
  job?: { name: string; runId: string; attempt?: number };
  queue?: { name: string; messageId: string; attempt?: number };
  /** The id of the request the failing code ran for, outside a request report. */
  requestId?: string;
  /** The database scope the failing code ran in (`tenant:<id>` for tenants), when not the root one. */
  scope?: string;
  tags: Record<string, string>;
  environment: "production" | "development";
  release?: string;
  at: Date;
}

/**
 * Receives every unexpected error of the service, like a logger receives its entries; a reporting service plugs in
 * with one: `errors: { reporter: myReporter }`.
 */
export interface ErrorReporter {
  report(report: ErrorReport): void | Promise<void>;
  /** Delivers the reports still pending, within `timeoutMs`; called on shutdown. */
  flush?(timeoutMs: number): Promise<void>;
}

/** What `reportError` takes besides the error. */
export interface ReportErrorExtra {
  tags?: Record<string, string>;
  user?: { id: string };
  tenant?: { id: string };
  /** The request the error belongs to; its id, method, path, route, safe headers and query are reported. */
  request?: ServiceRequest;
}

type Sink = (error: unknown, extra: ReportErrorExtra) => void;

const SINK = Symbol.for("quickservicets.errors.sink");
const slot = globalThis as unknown as { [SINK]?: Sink };

/** Sets (or removes) where `reportError` sends; the `errors` native sets it while it runs. */
export function setErrorReportSink(sink: Sink | undefined): void {
  slot[SINK] = sink;
}

/**
 * Sends a `manual` report of an error from any code, with optional tags, user, tenant and request; does nothing while
 * the `errors` native is disabled, and never throws.
 */
export function reportError(error: unknown, extra: ReportErrorExtra = {}): void {
  try {
    slot[SINK]?.(error, extra);
  } catch {
    // Reporting never fails the caller.
  }
}

/** What the framework knows about a failure outside a request: where it happened and for whom. */
export interface FailureDetails {
  kind: Exclude<ErrorReportKind, "request" | "manual">;
  tags?: Record<string, string>;
  user?: { id: string };
  tenant?: { id: string };
  requestId?: string;
  job?: ErrorReport["job"];
  queue?: ErrorReport["queue"];
}

type FailureSink = (error: unknown, details: FailureDetails) => void;
type StartupSink = (error: unknown, details: { feature?: string; phase?: string }) => Promise<void>;

const FAILURES = Symbol.for("quickservicets.errors.failures");
const STARTUP = Symbol.for("quickservicets.errors.startup");
const sinks = globalThis as unknown as { [FAILURES]?: FailureSink; [STARTUP]?: StartupSink };

/** Sets (or removes) where `reportFailure` and `reportStartupFailure` send; the `errors` native sets them. */
export function setFailureSinks(failures: FailureSink | undefined, startup: StartupSink | undefined): void {
  sinks[FAILURES] = failures;
  sinks[STARTUP] = startup;
}

/**
 * Reports a failure outside a request, like a failed event listener or outbox delivery; natives call it. Does nothing
 * while the `errors` native is disabled, and never throws.
 */
export function reportFailure(error: unknown, details: FailureDetails): void {
  try {
    sinks[FAILURES]?.(error, details);
  } catch {
    // Reporting never changes the outcome it describes.
  }
}

/** Reports a startup failure and waits for the reporters to deliver it; resolves at once without the `errors` native. */
export async function reportStartupFailure(error: unknown, details: { feature?: string; phase?: string }): Promise<void> {
  try {
    await sinks[STARTUP]?.(error, details);
  } catch {
    // The process exits with 1 either way.
  }
}
