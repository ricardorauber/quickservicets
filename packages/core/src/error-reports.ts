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
  job?: { name: string; runId: string; attempt?: number };
  queue?: { name: string; messageId: string; attempt?: number };
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

const SINK = Symbol.for("quickservice.errors.sink");
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
