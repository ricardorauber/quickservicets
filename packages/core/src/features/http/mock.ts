import { parseDuration } from "../public.ts";
import type { HttpBody, HttpRequest } from "./client.ts";
import { HttpClientError } from "./errors.ts";
import { sharedState } from "./state.ts";

/** What `replyWith` receives about a mocked call. */
export interface MockRequest {
  method: string;
  url: string;
  headers: Headers;
  /** The body as text, empty without one. */
  body: string;
}

/** What `replyWith` may return besides a `Response`: a status with an optional body (JSON for objects) and headers. */
export interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One call a mock received. */
export interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  attempt: number;
  service?: string;
}

/** How a mock answers the calls it matches; each method returns the handler, so they chain in any order. */
export interface MockHandler {
  /** Answers with a status, a body (objects and arrays as JSON) and headers. */
  reply(status: number, body?: unknown, headers?: Record<string, string>): MockHandler;
  /** Answers with what `fn` returns for the call: a `Response` or `{ status, body?, headers? }`. */
  replyWith(fn: (request: MockRequest) => Response | MockReply | Promise<Response | MockReply>): MockHandler;
  /** Fails the call with an `HttpClientError`, or with the `NETWORK` or `TIMEOUT` code. */
  fail(error: HttpClientError | "network" | "timeout"): MockHandler;
  /** Waits before answering, so timeouts can be tested. */
  delay(duration: string | number): MockHandler;
  /** Removes the handler after one match. */
  once(): MockHandler;
}

/** The handlers of a named service, matched by path. */
export interface MockService {
  on(method: string, path: string | RegExp): MockHandler;
}

/** The controller `http.mock()` returns. */
export interface HttpMock {
  /** Matches a method (or `"*"`) and a URL: exact, a prefix ending in `*`, or a `RegExp`; the latest handler wins. */
  on(method: string, pattern: string | RegExp): MockHandler;
  /** Matches the calls to a named service by their path. */
  service(name: string): MockService;
  /** Every call, in order. */
  readonly calls: MockCall[];
  /** The `.once()` handlers no call used. */
  pending(): { method: string; pattern: string }[];
  /** Puts the network back. */
  restore(): void;
}

type Answer = { kind: "reply"; status: number; body?: unknown; headers?: Record<string, string> } | { kind: "replyWith"; fn: (request: MockRequest) => Response | MockReply | Promise<Response | MockReply> } | { kind: "fail"; error: HttpClientError | "network" | "timeout" };

interface Handler {
  method: string;
  pattern: string | RegExp;
  service?: string;
  answer?: Answer;
  delayMs: number;
  once: boolean;
  used: boolean;
}

interface ActiveMock {
  handlers: Handler[];
  calls: MockCall[];
}

const state = sharedState("mock", () => ({ active: undefined as ActiveMock | undefined }));

/** Whether a mock answers the calls of this process. */
export function mockActive(): boolean {
  return state.active !== undefined;
}

/** Marks the error a `.fail("timeout")` handler throws, which the transport reports as a timeout. */
export const MOCK_TIMEOUT = Symbol.for("quickservicets.http.mock.timeout");

const text = (pattern: string | RegExp) => (typeof pattern === "string" ? pattern : String(pattern));

/** Whether a string pattern matches a URL: by prefix with a trailing `*`, else exactly, its query compared only when it has one. */
function matchesUrl(pattern: string | RegExp, url: URL): boolean {
  if (pattern instanceof RegExp) return pattern.test(url.href);
  if (pattern.endsWith("*")) return url.href.startsWith(pattern.slice(0, -1)) || `${url.origin}${url.pathname}`.startsWith(pattern.slice(0, -1));
  let expected: URL;
  try {
    expected = new URL(pattern);
  } catch {
    return false;
  }
  if (`${expected.origin}${expected.pathname}` !== `${url.origin}${url.pathname}`) return false;
  if (expected.search === "") return true;
  const sorted = (params: URLSearchParams) => [...params.entries()].map(([key, value]) => `${key}=${value}`).sort().join("&");
  return sorted(expected.searchParams) === sorted(url.searchParams);
}

/** The path of a URL relative to a service's base URL, with its query. */
function servicePath(url: URL, base: string): URL {
  const root = new URL(base);
  const prefix = root.pathname.replace(/\/+$/, "");
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : url.pathname;
  return new URL(`${path}${url.search}`, "http://service.invalid");
}

function matches(handler: Handler, request: HttpRequest, url: URL, serviceBase: string | undefined): boolean {
  if (handler.method !== "*" && handler.method.toUpperCase() !== request.method) return false;
  if (handler.service !== undefined) {
    if (handler.service !== request.service || serviceBase === undefined) return false;
    const path = servicePath(url, serviceBase);
    if (handler.pattern instanceof RegExp) return handler.pattern.test(`${path.pathname}${path.search}`);
    return matchesUrl(`http://service.invalid${handler.pattern}`, path);
  }
  return matchesUrl(handler.pattern, url);
}

async function bodyText(body: HttpBody | undefined): Promise<string> {
  if (body === undefined) return "";
  return new Response(body as ConstructorParameters<typeof Response>[0]).text();
}

/** A response from a reply: objects and arrays as JSON, strings and bytes as they are. */
function replyResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (body === undefined || body === null || status === 204 || status === 304) return new Response(null, { status, headers: lowered });
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob) return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: lowered });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...lowered } });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Answers a call from the active mock: records it, picks the latest matching handler, waits its delay and builds its
 * response; an unmatched call fails with `UNMATCHED_MOCK`.
 */
export async function answerFromMock(request: HttpRequest, signal: AbortSignal, serviceBase: string | undefined, maskedUrl: string): Promise<Response> {
  const active = state.active!;
  const url = new URL(request.url);
  const body = await bodyText(request.body);
  active.calls.push({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    attempt: request.attempt,
    ...(request.service !== undefined ? { service: request.service } : {}),
  });
  const handler = [...active.handlers].reverse().find((candidate) => candidate.answer !== undefined && matches(candidate, request, url, serviceBase));
  if (!handler) {
    throw new HttpClientError({
      code: "UNMATCHED_MOCK",
      message: `Unmatched request ${request.method} ${maskedUrl}`,
      method: request.method,
      url: maskedUrl,
      details: { patterns: active.handlers.filter((candidate) => candidate.answer !== undefined).map(describe) },
      ...(request.service !== undefined ? { service: request.service } : {}),
    });
  }
  handler.used = true;
  if (handler.once) active.handlers.splice(active.handlers.indexOf(handler), 1);
  if (handler.delayMs > 0) await wait(handler.delayMs, signal);
  const answer = handler.answer!;
  if (answer.kind === "fail") {
    if (answer.error === "network") throw Object.assign(new Error("connection refused (mocked)"), { code: "ConnectionRefused" });
    if (answer.error === "timeout") throw Object.assign(new Error("timed out (mocked)"), { [MOCK_TIMEOUT]: true });
    throw answer.error;
  }
  if (answer.kind === "reply") return replyResponse(answer.status, answer.body, answer.headers);
  const result = await answer.fn({ method: request.method, url: request.url, headers: new Headers(request.headers), body });
  return result instanceof Response ? result : replyResponse(result.status, result.body, result.headers);
}

const describe = (handler: Handler) => ({ method: handler.method, pattern: handler.service !== undefined ? `${handler.service}:${text(handler.pattern)}` : text(handler.pattern) });

/**
 * Answers every outgoing call of the process (`http`, `req.http`, `ctx.http` and services) from canned handlers until
 * `restore()`, without a network; modifiers, timeouts, size limits and logging still run.
 */
export function mockHttp(): HttpMock {
  if (state.active) throw new Error("http.mock() is already active; call restore() first");
  const active: ActiveMock = { handlers: [], calls: [] };
  state.active = active;
  const handlerOf = (method: string, pattern: string | RegExp, service?: string): MockHandler => {
    const entry: Handler = { method, pattern, delayMs: 0, once: false, used: false, ...(service !== undefined ? { service } : {}) };
    active.handlers.push(entry);
    const handler: MockHandler = {
      reply: (status, body, headers) => ((entry.answer = { kind: "reply", status, body, ...(headers ? { headers } : {}) }), handler),
      replyWith: (fn) => ((entry.answer = { kind: "replyWith", fn }), handler),
      fail: (error) => ((entry.answer = { kind: "fail", error }), handler),
      delay: (duration) => ((entry.delayMs = typeof duration === "number" ? duration : (parseDuration(duration) ?? 0)), handler),
      once: () => ((entry.once = true), handler),
    };
    return handler;
  };
  return {
    on: (method, pattern) => handlerOf(method, pattern),
    service: (name) => ({ on: (method, path) => handlerOf(method, path, name) }),
    calls: active.calls,
    pending: () => active.handlers.filter((handler) => handler.once && !handler.used).map(describe),
    restore() {
      if (state.active === active) state.active = undefined;
    },
  };
}
