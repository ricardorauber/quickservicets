import { bodyPolicyOf, bodyTooLarge, deferRequestLog, HttpClientError, HttpError, joinPath, peerAddress, runAfterHooks, runBeforeHooks, safeLog, serviceUrl, streamCall, type FeatureHook, type Logger, type ServiceRequest } from "../public.ts";
import { IDENTITY_HEADERS, signIdentity } from "./identity.ts";

/** The hop-by-hop headers, never forwarded in either direction. */
export const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** A proxy route as the forwarder uses it. */
export interface ProxyRoute {
  name: string;
  /** The route's path as configured: an exact path, or a prefix ending in `/*`. */
  path: string;
  /** The service the route calls: `proxy/<name>` for a target, or the configured service. */
  service: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  preserveHost: boolean;
  /** The upstream path of a request, when the route strips its prefix or rewrites; the full path otherwise. */
  upstreamPath?: (req: ServiceRequest) => string;
  /** Checks the request's user, roles and scopes before any upstream call; throws the 401 or 403. */
  authorize?: (req: ServiceRequest) => void;
  /** What the route forwards of the request's identity and credentials. */
  forward: ReadonlySet<"user" | "roles" | "tenant" | "authorization" | "cookie">;
  /** The header of the signed identity, removed from every client request. */
  identityHeader: string;
  /** The signed identity header added to every proxied request, when a secret is set. */
  identity?: { secret: string; header: string };
  /** Whether the gateway answers CORS for the route, so the upstream's `access-control-*` headers are removed. */
  cors?: boolean;
  /**
   * Chooses the upstream per request (a target function): resolves the base URL, which must be on one of the route's
   * allowed origins, each a service of its own.
   */
  pickTarget?: (req: ServiceRequest) => Promise<string | undefined>;
  /** The services of the allowed targets, by origin. */
  allowed?: ReadonlyMap<string, string>;
}

/** What `beforeProxy` hooks receive: the request, the route's name and the upstream request about to be sent. */
export interface ProxyStep {
  req: ServiceRequest;
  route: string;
  upstream: { url: string; headers: Headers };
}

/** What `afterProxy` hooks receive once the upstream answered. */
export interface ProxyDone {
  req: ServiceRequest;
  route: string;
  status: number;
  headers: Headers;
  durationMs: number;
}

/** What `onProxyError` hooks receive when the upstream call failed. */
export interface ProxyFailure {
  req: ServiceRequest;
  route: string;
  error: unknown;
}

/** Replaces how the gateway calls upstreams, once authentication, identity headers, security options and hooks ran. */
export interface ProxyForwarder {
  forward(call: { request: Request; url: string; route: string; signal: AbortSignal }): Promise<Response>;
}

/** What forwarding needs besides the route: the hooks, the forwarder, the logger and whether the service runs in production. */
export interface ForwardContext {
  production: boolean;
  logger: Logger;
  beforeProxy: readonly FeatureHook<ProxyStep, undefined>[];
  afterProxy: readonly FeatureHook<ProxyDone, undefined>[];
  onProxyError: readonly FeatureHook<ProxyFailure, undefined>[];
  forwarder?: ProxyForwarder;
}

/** What `proxyRequest` may change of a route's forwarding for one call. */
export interface ProxyOverrides {
  /** The upstream path, instead of the route's. */
  path?: string;
  /** Headers set on the upstream request. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * The request body counted as it streams to the upstream, failing once it passes `maxBytes` (the route's or the
 * service's body limit), which aborts the upstream call.
 */
function limitedBody(body: ReadableStream<Uint8Array>, maxBytes: number, onTooLarge: () => void): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          onTooLarge();
          controller.error(bodyTooLarge(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Removes the hop-by-hop headers, and those `connection` lists, from a copy of `headers`. */
export function withoutHopByHop(headers: Headers): Headers {
  const copy = new Headers(headers);
  const listed = (headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
  for (const name of [...HOP_BY_HOP, ...listed]) copy.delete(name);
  return copy;
}

/**
 * The headers the upstream receives: the client's without the hop-by-hop ones, `cookie` and `authorization`, with
 * `x-forwarded-for` (the trusted chain with the peer appended), `x-forwarded-proto`, `x-forwarded-host`,
 * `x-request-id` and the upstream's own `host` unless `preserveHost`.
 */
export function forwardedHeaders(req: ServiceRequest, route: Pick<ProxyRoute, "preserveHost" | "forward" | "identityHeader">): Headers {
  const headers = withoutHopByHop(req.headers);
  // A client never claims an identity: its own identity headers go, whatever the route forwards.
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  headers.delete(route.identityHeader);
  if (!route.forward.has("cookie")) headers.delete("cookie");
  if (!route.forward.has("authorization")) headers.delete("authorization");
  const user = req.user as { id?: unknown; roles?: unknown } | undefined;
  if (route.forward.has("user") && user?.id !== undefined) headers.set("x-user-id", String(user.id));
  if (route.forward.has("roles") && Array.isArray(user?.roles)) headers.set("x-user-roles", (user!.roles as string[]).join(","));
  const tenant = (req.tenant as { id?: unknown } | undefined)?.id;
  if (route.forward.has("tenant") && tenant !== undefined) headers.set("x-tenant-id", String(tenant));
  const peer = peerAddress(req.raw);
  const incoming = req.headers.get("x-forwarded-for");
  // When a trusted proxy's chain gave req.ip, the chain goes on with the peer; otherwise the peer starts it.
  const chain = incoming !== null && req.ip !== peer ? `${incoming}, ${peer}` : req.ip === "unknown" ? peer : req.ip;
  headers.set("x-forwarded-for", chain);
  headers.set("x-forwarded-proto", new URL(req.raw.url).protocol.replace(/:$/, ""));
  const host = req.headers.get("host");
  if (host !== null) headers.set("x-forwarded-host", host);
  headers.set("x-request-id", req.id);
  if (!route.preserveHost) headers.delete("host");
  return headers;
}

/** Signs the forwarded identity of an upstream request over its final method and path. */
function sign(identity: { secret: string; header: string }, method: string, url: string, headers: Headers): void {
  const path = new URL(url).pathname;
  const values = { user: headers.get("x-user-id"), roles: headers.get("x-user-roles"), tenant: headers.get("x-tenant-id") };
  headers.set(identity.header, signIdentity(identity.secret, Math.floor(Date.now() / 1000), method, path, values));
}

/** The refusal of a target outside the route's allowed origins: logged, and answered like a failed upstream. */
function refusedTarget(context: ForwardContext, route: ProxyRoute, origin: string): HttpError {
  safeLog(context.logger, "warn", { timestamp: new Date().toISOString(), message: "proxy.target.refused", route: route.name, origin });
  return new HttpError(502, "Upstream request failed", { code: "BAD_GATEWAY" });
}

/** The answer of a failed upstream call: 504 for a timeout, 503 for an open circuit or a full bulkhead, else 502. */
export function upstreamError(error: unknown, production: boolean): HttpError {
  if (!(error instanceof HttpClientError)) return new HttpError(502, "Upstream request failed", { code: "BAD_GATEWAY" });
  const details = production ? undefined : { code: error.code, url: error.url, ...(error.service !== undefined ? { service: error.service } : {}) };
  if (error.code === "CIRCUIT_OPEN" || error.code === "BULKHEAD_FULL") {
    const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
    return new HttpError(503, "Upstream unavailable", { code: "SERVICE_UNAVAILABLE", ...(details ? { details } : {}), ...(retryAfter !== undefined ? { headers: { "retry-after": String(retryAfter) } } : {}) });
  }
  if (error.code === "TIMEOUT") return new HttpError(504, "Upstream request timed out", { code: "GATEWAY_TIMEOUT", ...(details ? { details } : {}) });
  return new HttpError(502, "Upstream request failed", { code: "BAD_GATEWAY", ...(details ? { details } : {}) });
}


/**
 * Forwards a request to its route's upstream, streaming the body both ways, and returns the upstream's response with
 * the hop-by-hop headers removed; the request log entry gets `proxy: <route>` once the response body ended.
 */
export async function forwardRequest(req: ServiceRequest, route: ProxyRoute, context: ForwardContext, overrides: ProxyOverrides = {}): Promise<Response> {
  route.authorize?.(req);
  const path = overrides.path ?? (route.upstreamPath ? route.upstreamPath(req) : req.path);
  const search = new URL(req.raw.url).search;
  // The service of the call, and the base URL its path joins: the route's own, or the one its target function chose.
  let service = route.service;
  let base: string;
  if (route.pickTarget) {
    const chosen = await route.pickTarget(req);
    let origin = "";
    try {
      origin = chosen === undefined ? "" : new URL(chosen).origin;
    } catch {
      origin = String(chosen);
    }
    const allowed = route.allowed?.get(origin);
    if (!allowed || chosen === undefined) throw refusedTarget(context, route, origin);
    service = allowed;
    base = chosen;
  } else base = serviceUrl(service);
  let url = joinPath(base, `${path}${search}`).href;
  const method = req.method;
  const headers = forwardedHeaders(req, route);
  for (const [name, value] of Object.entries(overrides.headers ?? {})) headers.set(name, value);
  if (context.beforeProxy.length > 0) {
    const changed = (await runBeforeHooks(context.beforeProxy, { req, route: route.name, upstream: { url, headers } }, undefined)) as ProxyStep | ProxyStep["upstream"];
    // A hook returns the step with a changed upstream, or the upstream itself.
    const next = "upstream" in changed ? changed.upstream : "url" in changed ? changed : { url, headers };
    if (new URL(next.url).origin !== new URL(url).origin) throw refusedTarget(context, route, new URL(next.url).origin);
    url = next.url;
    if (next.headers !== headers) for (const [name, value] of new Headers(next.headers)) headers.set(name, value);
  }
  if (route.identity) sign(route.identity, method, url, headers);
  const hasBody = method !== "GET" && method !== "HEAD" && req.raw.body !== null;
  const maxBytes = hasBody ? bodyPolicyOf(req.raw)?.maxBytes : undefined;
  let tooLarge = false;
  const aborted = new AbortController();
  const body = !hasBody ? undefined : maxBytes === undefined ? req.raw.body! : limitedBody(req.raw.body!, maxBytes, () => ((tooLarge = true), aborted.abort()));
  const signal = AbortSignal.any([req.raw.signal, aborted.signal]);
  const started = performance.now();
  let upstream: Response;
  try {
    upstream = context.forwarder
      ? await context.forwarder.forward({ request: new Request(url, { method, headers, body: body ?? null, signal, redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit), url, route: route.name, signal })
      : await streamCall({ method, url, headers, ...(body ? { body } : {}), service, timeout: route.timeoutMs, idleTimeout: route.idleTimeoutMs, signal, req });
  } catch (error) {
    if (context.onProxyError.length > 0) await runAfterHooks(context.onProxyError, { req, route: route.name, error }, undefined);
    if (tooLarge) throw bodyTooLarge(maxBytes!);
    if (error instanceof HttpError) throw error;
    throw upstreamError(error, context.production);
  }
  let ended!: () => void;
  const finished = new Promise<Record<string, unknown>>((resolve) => (ended = () => resolve({ proxy: route.name })));
  const answered = upstream.body ? upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => ended() })) : null;
  if (!answered) ended();
  const responseHeaders = withoutHopByHop(upstream.headers);
  // With the gateway's CORS policy, the browser sees only that one.
  if (route.cors) for (const name of [...responseHeaders.keys()]) if (name.startsWith("access-control-")) responseHeaders.delete(name);
  if (context.afterProxy.length > 0) await runAfterHooks(context.afterProxy, { req, route: route.name, status: upstream.status, headers: responseHeaders, durationMs: performance.now() - started }, undefined);
  const response = new Response(answered, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  // A cancelled download ends the entry too.
  req.raw.signal.addEventListener("abort", () => ended(), { once: true });
  deferRequestLog(response, finished);
  return response;
}
