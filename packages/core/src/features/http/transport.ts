import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { formatSize, maskUrl, parseSize, safeLog } from "../public.ts";
import type { HttpBody, HttpRequest, HttpResponse, HttpSettings } from "./client.ts";
import { allowList, blockedCategory, isReservedName, RESERVED_NAME, resolveHost, type AllowList } from "./ssrf.ts";
import { HttpClientError } from "./errors.ts";

/** A URL as logs and errors show it: secret query values and user information replaced with `[secret]`. */
export function maskedUrl(url: string, settings: Pick<HttpSettings, "maskKeys">): string {
  return maskUrl(url, { keys: settings.maskKeys });
}

/** A response whose body was read in full. */
export class BufferedResponse implements HttpResponse {
  readonly ok: boolean;

  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly url: string,
    readonly body: Uint8Array,
    private readonly invalid: (cause: unknown) => Error,
  ) {
    this.ok = status >= 200 && status < 300;
  }

  async json<T = unknown>(): Promise<T> {
    try {
      return JSON.parse(new TextDecoder().decode(this.body)) as T;
    } catch (error) {
      throw this.invalid(error);
    }
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.body);
  }

  async bytes(): Promise<Uint8Array> {
    return this.body.slice();
  }
}

/** The text of a size, like `10MB`, for messages. */
function sizeText(value: string | number): string {
  return typeof value === "string" && !/^\d+$/.test(value.trim()) ? value : formatSize(parseSize(value) ?? 0);
}

/** Reads a body up to `limit` bytes; past it, stops reading and calls `tooLarge`. */
async function readLimited(response: Response, limit: number, tooLarge: () => Error): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The reason of a network failure, as the message shows it. */
function reasonOf(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  if (typeof failure?.code === "string" && failure.code !== "") return failure.code;
  return typeof failure?.message === "string" ? failure.message : String(error);
}

/** Marks the request of an attempt with what the cache did: `miss`, `bypass`, or `revalidate` for a conditional call. */
export const CACHE_LABEL = Symbol.for("quickservicets.http.cache");

/** The statuses the client follows as redirects. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The validated destination of one hop: the address to connect to, absent when SSRF protection is off. */
interface Destination {
  address?: string;
}

/**
 * Checks one hop's URL: only `http` and `https`, and with SSRF protection on, no reserved name and no resolved address
 * in a blocked range unless `allow` (or the trusted host of the call's service) lets it through. Resolves the address
 * to connect to.
 */
export async function checkDestination(url: URL, settings: HttpSettings, trustedHost: string | undefined): Promise<Destination> {
  const protocol = url.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") throw blocked(url, settings, `Blocked request to ${maskedUrl(url.href, settings)}: protocol ${protocol} is not allowed`);
  if (!settings.options.ssrf) return {};
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allow = allowListOf(settings.options.allow);
  const trusted = allow.host(host) || (trustedHost !== undefined && trustedHost === url.host.toLowerCase());
  if (!trusted && isReservedName(host)) throw blockedAddress(url, settings, host, host, RESERVED_NAME);
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch((error: unknown) => {
    throw Object.assign(new Error(`could not resolve ${host}`), { cause: error, code: "ENOTFOUND" });
  });
  if (addresses.length === 0) throw Object.assign(new Error(`could not resolve ${host}`), { code: "ENOTFOUND" });
  if (!trusted) {
    for (const address of addresses) {
      const category = blockedCategory(address);
      if (category && !allow.address(address)) throw blockedAddress(url, settings, host, address, category);
    }
  }
  return { address: addresses[0]! };
}

/** The `allow` list compiled once per list. */
const compiled = new WeakMap<readonly string[], AllowList>();
function allowListOf(items: readonly string[]): AllowList {
  let list = compiled.get(items);
  if (!list) compiled.set(items, (list = allowList(items)));
  return list;
}

/** An `SSRF_BLOCKED` error, marked so the transport fills in the method. */
function blocked(url: URL, settings: HttpSettings, message: string): HttpClientError {
  return new HttpClientError({ code: "SSRF_BLOCKED", message, method: "", url: maskedUrl(url.href, settings) });
}

/** An `SSRF_BLOCKED` error for a blocked name or address, logged as `http.ssrf.blocked` without the query string. */
function blockedAddress(url: URL, settings: HttpSettings, host: string, address: string, category: string): HttpClientError {
  safeLog(settings.logger, "warn", { timestamp: new Date().toISOString(), message: "http.ssrf.blocked", host, address, category });
  return blocked(url, settings, `Blocked request to ${host}: ${address} is ${category}`);
}

/** The URL to connect to: the validated address in place of the host name, keeping the port and path. */
function pinnedUrl(url: URL, address: string | undefined): string {
  if (address === undefined || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return url.href;
  const pinned = new URL(url.href);
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return pinned.href;
}

/** One hop being sent. */
interface Hop {
  url: URL;
  method: string;
  headers: Headers;
  body: HttpBody | undefined;
}

/** Sends one hop to its validated address, with the original host in the `host` header and as the TLS server name. */
async function sendHop(hop: Hop, destination: Destination, signal: AbortSignal): Promise<Response> {
  const headers = new Headers(hop.headers);
  const target = pinnedUrl(hop.url, destination.address);
  if (target !== hop.url.href) headers.set("host", hop.url.host);
  const servername = hop.url.hostname;
  const tls = hop.url.protocol === "https:" && target !== hop.url.href ? { tls: { serverName: servername, checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(servername, cert) } } : {};
  return fetch(target, { method: hop.method, headers, body: (hop.body ?? null) as RequestInit["body"], signal, redirect: "manual", ...tls } as RequestInit);
}

/**
 * Sends one attempt of a request over the network: every hop is checked by SSRF protection and sent to the address it
 * validated, redirects are followed by the client up to `maxRedirects`, the timeout covers reading the body, the body
 * is read up to the size limit, and failures become `HttpClientError`s.
 */
export async function transport(request: HttpRequest, settings: HttpSettings, trustedHost?: string): Promise<HttpResponse> {
  const { method } = request;
  const url = maskedUrl(request.url, settings);
  const service = request.service !== undefined ? { service: request.service } : {};
  const fail = (code: string, message: string, cause?: unknown) => new HttpClientError({ code, message, method, url, ...(cause !== undefined ? { cause } : {}), ...service });
  if (request.signal?.aborted) throw fail("ABORTED", `${method} ${url} was aborted`, request.signal.reason);
  const limit = parseSize(settings.options.maxResponseSize) ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeout);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const failure = (error: unknown) => {
    if (error instanceof HttpClientError) {
      // Checks raise errors without the call's method and service; they are the call's.
      return error.method === "" ? new HttpClientError({ code: error.code, message: error.message, method, url: error.url, ...service }) : error;
    }
    if (timedOut) return fail("TIMEOUT", `${method} ${url} timed out after ${formatTimeoutText(request.timeout)}`, error);
    if (request.signal?.aborted) return fail("ABORTED", `${method} ${url} was aborted`, request.signal.reason);
    return fail("NETWORK", `${method} ${url} failed: ${reasonOf(error)}`, error);
  };
  const startedAt = performance.now();
  let status = 0;
  let failed: HttpClientError | undefined;
  try {
    let hop: Hop = { url: new URL(request.url), method, headers: new Headers(request.headers), body: request.body };
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      const destination = await checkDestination(hop.url, settings, trustedHost);
      response = await sendHop(hop, destination, signal);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) break;
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= settings.options.maxRedirects) throw fail("TOO_MANY_REDIRECTS", `Too many redirects from ${url}`);
      hop = redirected(hop, response.status, new URL(location, hop.url));
    }
    status = response.status;
    const tooLarge = () => fail("RESPONSE_TOO_LARGE", `Response from ${url} is larger than ${sizeText(settings.options.maxResponseSize)}`);
    const body = await readLimited(response, limit, tooLarge);
    const answered = hop.url.href;
    const invalid = (cause: unknown) => new HttpClientError({ code: "INVALID_RESPONSE", message: `${method} ${maskedUrl(answered, settings)} answered invalid JSON`, method, url: maskedUrl(answered, settings), cause, ...service });
    return new BufferedResponse(response.status, response.headers, answered, body, invalid);
  } catch (error) {
    failed = failure(error);
    throw failed;
  } finally {
    clearTimeout(timer);
    const label = (request as HttpRequest & { [CACHE_LABEL]?: string })[CACHE_LABEL];
    const cache = label === "revalidate" ? (status === 304 ? "revalidated" : "miss") : label;
    logCall(settings, request, { url, status: failed && failed.code !== "RESPONSE_TOO_LARGE" ? 0 : status, durationMs: performance.now() - startedAt, ...(failed ? { error: failed.code } : {}), ...(cache ? { cache } : {}) });
  }
}

/** What one attempt ended with, for its log entry. */
export interface CallOutcome {
  /** The masked URL. */
  url: string;
  status: number;
  durationMs: number;
  /** The `HttpClientError` code of a failed attempt. */
  error?: string;
  /** Whether a response cache answered, for calls through one. */
  cache?: string;
  attempt?: number;
}

/**
 * Writes the `http.call` entry of one attempt: method, masked URL, service, status, duration, attempt, request id and
 * error code, never headers or bodies; `info` below 400 and `warn` otherwise, as the `log` option allows.
 */
export function logCall(settings: HttpSettings, request: HttpRequest, outcome: CallOutcome): void {
  const service = request.service === undefined ? undefined : settings.services.get(request.service);
  const mode = service?.log ?? settings.options.log;
  const bad = outcome.error !== undefined || outcome.status >= 400;
  if (mode === "off" || (mode === "errors" && !bad)) return;
  const requestId = request.headers.get("x-request-id");
  safeLog(settings.logger, bad ? "warn" : "info", {
    timestamp: new Date().toISOString(),
    message: "http.call",
    method: request.method,
    url: outcome.url,
    ...(request.service !== undefined ? { service: request.service } : {}),
    status: outcome.status,
    durationMs: Math.round(outcome.durationMs * 1000) / 1000,
    attempt: outcome.attempt ?? request.attempt,
    ...(requestId !== null ? { requestId } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.cache !== undefined ? { cache: outcome.cache } : {}),
  });
}

/**
 * The next hop after a redirect: 307 and 308 keep the method and body, 301, 302 and 303 switch to `GET` without a body,
 * and a change of origin drops the `authorization` and `cookie` headers.
 */
export function redirected(hop: Hop, status: number, location: URL): Hop {
  const headers = new Headers(hop.headers);
  const keep = status === 307 || status === 308;
  if (location.origin !== hop.url.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
  }
  if (keep) return { url: location, method: hop.method, headers, body: hop.body };
  headers.delete("content-type");
  headers.delete("content-length");
  return { url: location, method: hop.method === "HEAD" ? "HEAD" : "GET", headers, body: undefined };
}

/** A timeout as messages show it: `500ms`, `10s`. */
function formatTimeoutText(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
