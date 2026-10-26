import { HttpError } from "../errors.ts";
import type { Repositories, ServiceRequest, ServiceResponse } from "../hooks.ts";
import type { Endpoint } from "./server.ts";

/** What `stream.send` takes besides the data. */
export interface SseSendOptions {
  /** The event name, `message` for clients when absent; no line breaks. */
  event?: string;
  /** The event id a reconnecting client sends back as `Last-Event-ID`; no line breaks. */
  id?: string;
  /** How long a client waits before reconnecting, in milliseconds. */
  retry?: number;
}

/** An open Server-Sent Events stream, as an `sse.ts` handler receives it. */
export interface SseStream {
  /** Writes one message: a string as it is (one `data:` line per line), any other value as JSON. Ignored once closed. */
  send(data: unknown, options?: SseSendOptions): void;
  /** Writes a comment line, which clients ignore. Ignored once closed. */
  comment(text: string): void;
  /** Ends the stream. */
  close(): void;
  /** Aborted when the client disconnects or the stream closes. */
  readonly signal: AbortSignal;
  /** Resolves once the stream closed. */
  readonly closed: Promise<void>;
}

/** The handler of an `sse.ts` endpoint: it runs with an open stream and may keep writing after it resolves. */
export type SseHandler = (stream: SseStream, repos: Repositories, req: ServiceRequest) => void | Promise<void>;

const SSE = Symbol.for("quickservice.sse");

/** What `defineSse` returns, the default export of an `sse.ts` endpoint. */
export interface SseDefinition {
  readonly [SSE]: true;
  readonly handler: SseHandler;
}

/**
 * Declares the handler of an `endpoints/<path>/sse.ts` file, served as `GET <path>` with a `text/event-stream`
 * response once the endpoint's pre-hooks passed:
 *
 * ```ts
 * export default defineSse((stream) => {
 *   const timer = setInterval(() => stream.send({ now: new Date() }), 1000);
 *   stream.signal.addEventListener("abort", () => clearInterval(timer));
 * });
 * ```
 */
export function defineSse(handler: SseHandler): SseDefinition {
  if (typeof handler !== "function") throw new Error("defineSse needs a handler function");
  return { [SSE]: true, handler };
}

/** Whether a value is what `defineSse(...)` returns. */
export function isSseDefinition(value: unknown): value is SseDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SSE] === true;
}

/** Answers a request of an `sse.ts` endpoint with a streaming response; the `realtime` native sets it. */
export type SseRunner = (definition: SseDefinition, repos: Repositories, req: ServiceRequest, res: ServiceResponse) => Promise<Response>;

const RUNNER = Symbol.for("quickservice.sse.runner");
const slot = globalThis as unknown as { [RUNNER]?: SseRunner };

/** Sets (or, with undefined, removes) what serves `sse.ts` endpoints; without one they answer 404. */
export function setSseRunner(runner: SseRunner | undefined): void {
  slot[RUNNER] = runner;
}

/** The route handler of an `sse.ts` endpoint: 404 `Route not found` while no runner serves Server-Sent Events. */
export function sseEndpoint(definition: SseDefinition): Endpoint {
  return (repos, req, res) => {
    const runner = slot[RUNNER];
    if (!runner) throw new HttpError(404, "Route not found");
    return runner(definition, repos, req, res);
  };
}
