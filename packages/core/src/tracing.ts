import { AsyncLocalStorage } from "node:async_hooks";
import { secretVariableValues } from "./env-vars.ts";
import { DEFAULT_MASKED_KEYS, maskEntry } from "./features/security/masking.ts";
import type { LogEntry, LogMasker, Logger } from "./logger.ts";
import { activeSetup } from "./setup-phase.ts";

/** The role of a span in a trace, as OpenTelemetry names them. */
export type SpanKind = "server" | "client" | "internal" | "producer" | "consumer";

/** A value a span attribute may hold. */
export type SpanAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** Span attributes by name. */
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** The identity of a span, as W3C trace context carries it. */
export interface SpanContext {
  /** 32 lowercase hex digits. */
  traceId: string;
  /** 16 lowercase hex digits. */
  spanId: string;
  /** The trace flags, 1 when the trace is sampled. */
  traceFlags: number;
  /** The `tracestate` header that came with the context, kept as given. */
  traceState?: string;
}

/** A link from a span to another span, like a queue message's run to the span that sent it. */
export interface SpanLink {
  context: SpanContext;
  attributes?: SpanAttributes;
}

/** What `startSpan` takes besides the name. */
export interface SpanOptions {
  /** The role of the span (default `internal`). */
  kind?: SpanKind;
  attributes?: SpanAttributes;
  /** The parent span's context, or null for a new trace (default: the active span). */
  parent?: SpanContext | null;
  links?: readonly SpanLink[];
  /** When the span started, in milliseconds since the epoch (default: now). */
  startTime?: number;
}

/** A unit of work in a trace. */
export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): Span;
  setAttributes(attributes: SpanAttributes): Span;
  addEvent(name: string, attributes?: SpanAttributes): Span;
  recordException(error: unknown): Span;
  setStatus(code: "ok" | "error", message?: string): Span;
  updateName(name: string): Span;
  /** Ends the span, at `endTime` (milliseconds since the epoch) or now. */
  end(endTime?: number): void;
  /** False for spans that record nothing, like the no-op tracer's. */
  isRecording(): boolean;
  context(): SpanContext;
}

/** Creates spans; a telemetry implementation (like an OpenTelemetry plugin) sets one with `setTracer`. */
export interface Tracer {
  startSpan(name: string, options: SpanOptions): Span;
}

const INVALID_CONTEXT: SpanContext = Object.freeze({ traceId: "00000000000000000000000000000000", spanId: "0000000000000000", traceFlags: 0 });

/** The one span the no-op tracer returns: it records nothing. */
const NOOP_SPAN: Span = Object.freeze({
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  recordException: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  updateName: () => NOOP_SPAN,
  end: () => {},
  isRecording: () => false,
  context: () => INVALID_CONTEXT,
});

/** The tracer of a service without one: every span is the shared non-recording span. */
export const noopTracer: Tracer = Object.freeze({ startSpan: () => NOOP_SPAN });

/** The tracer a feature set during setup, with the feature's key. */
export interface TracerSetting {
  owner: string;
  tracer: Tracer;
}

let tracer: Tracer = noopTracer;
let enabled = false;
/** The active span of the async code running now; created only once a tracer is set. */
let spans: AsyncLocalStorage<Span> | undefined;
let attributeMask: LogMasker | undefined;

/**
 * Sets the tracer of the service, so the core and the natives trace requests, calls and background work through it.
 * Only one feature may set it, during its setup.
 */
export function setTracer(value: Tracer): void {
  const setup = activeSetup();
  if (!setup) throw new Error("setTracer() is only available during feature setup");
  if (typeof value?.startSpan !== "function") throw new Error("setTracer() takes an object with startSpan(name, options)");
  const current = setup.server.tracer;
  if (current) throw new Error(`A tracer is already set by ${current.owner}`);
  setup.server.tracer = { owner: setup.feature, tracer: value };
  configureTracing(setup.server.tracer, setup.server.mask);
}

/**
 * Makes `setting` the tracer of the running service (the no-op tracer without one), with the masker its attributes go
 * through; `createApp` calls it with the service's settings.
 */
export function configureTracing(setting: TracerSetting | undefined, mask?: LogMasker): void {
  tracer = setting?.tracer ?? noopTracer;
  enabled = setting !== undefined;
  if (enabled) spans ??= new AsyncLocalStorage<Span>();
  attributeMask = mask;
}

/** Whether a tracer is set; instrumentation checks it before building any name, attribute or option. */
export function tracingEnabled(): boolean {
  return enabled;
}

/** The span active in the async code running now, or undefined. */
export function activeSpan(): Span | undefined {
  return enabled ? spans?.getStore() : undefined;
}

/** Starts a span through the service's tracer; its parent is the active span unless `options.parent` says otherwise. */
export function startSpan(name: string, options: SpanOptions = {}): Span {
  if (!enabled) return tracer.startSpan(name, options);
  if (options.parent !== undefined) return tracer.startSpan(name, options);
  const parent = spans?.getStore()?.context() ?? null;
  return tracer.startSpan(name, { ...options, parent });
}

/** Runs `fn` with `span` active for its async continuations; without a tracer, calls `fn` directly. */
export function withSpan<T>(span: Span, fn: () => T): T {
  if (!enabled || !spans) return fn();
  return spans.run(span, fn);
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "00000000000000000000000000000000";
const ZERO_SPAN = "0000000000000000";

/** The longest `tracestate` kept. */
export const MAX_TRACESTATE = 512;

/**
 * The span context of a W3C `traceparent` header (version `00`, lowercase hex ids that are not all zeros), with the
 * `tracestate` kept as given up to 512 characters; undefined for any other value.
 */
export function parseTraceparent(header: string | null | undefined, tracestate?: string | null): SpanContext | undefined {
  if (typeof header !== "string") return undefined;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  const context: SpanContext = { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
  if (typeof tracestate === "string" && tracestate !== "" && tracestate.length <= MAX_TRACESTATE) context.traceState = tracestate;
  return context;
}

/** The W3C `traceparent` header of a span context. */
export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${(context.traceFlags & 0xff).toString(16).padStart(2, "0")}`;
}

const CREDENTIAL_KEYS = DEFAULT_MASKED_KEYS.map((key) => key.toLowerCase());
const credentialNames = new Map<string, boolean>();

/** Whether an attribute's name reads like a credential (`authorization`, `api_key`, `password`, ...). */
function credentialName(name: string): boolean {
  let found = credentialNames.get(name);
  if (found === undefined) {
    const lower = name.toLowerCase().replace(/[-_]/g, "");
    found = CREDENTIAL_KEYS.some((key) => lower.includes(key));
    if (credentialNames.size < 10_000) credentialNames.set(name, found);
  }
  return found;
}

function maskValue(value: string): string {
  if (attributeMask) return attributeMask.entry(value);
  return maskEntry(value, { keys: DEFAULT_MASKED_KEYS, secrets: secretVariableValues() });
}

/**
 * The attributes the core and natives set on spans: keys named like credentials are dropped, and string values are
 * masked like log entries, so declared secret values read `[secret]`. Undefined values are left out.
 */
export function spanAttributes(record: Readonly<Record<string, SpanAttributeValue | undefined | null>>): SpanAttributes {
  const attributes: SpanAttributes = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined || value === null || credentialName(key)) continue;
    if (typeof value === "string") attributes[key] = maskValue(value);
    else if (Array.isArray(value)) attributes[key] = value.map((item) => (typeof item === "string" ? maskValue(item) : item)) as SpanAttributeValue;
    else attributes[key] = value;
  }
  return attributes;
}

/** A logger adding the active span's `traceId` and `spanId` to every entry that does not set them. */
export function tracedLogger(logger: Logger): Logger {
  const add = (entry: LogEntry): LogEntry => {
    if (!enabled) return entry;
    const span = spans?.getStore();
    if (!span) return entry;
    const context = span.context();
    if (entry.traceId !== undefined && entry.spanId !== undefined) return entry;
    return { ...entry, ...(entry.traceId === undefined ? { traceId: context.traceId } : {}), ...(entry.spanId === undefined ? { spanId: context.spanId } : {}) };
  };
  return {
    info: (entry) => logger.info(add(entry)),
    warn: (entry) => logger.warn(add(entry)),
    error: (entry) => logger.error(add(entry)),
    ...(logger.debug ? { debug: (entry: LogEntry) => logger.debug?.(add(entry)) } : {}),
  };
}
