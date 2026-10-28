import { deferRequestLog, HttpClientError, HttpError, peerAddress, streamCall, type ServiceRequest } from "../public.ts";

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
export function forwardedHeaders(req: ServiceRequest, route: Pick<ProxyRoute, "preserveHost">): Headers {
  const headers = withoutHopByHop(req.headers);
  headers.delete("cookie");
  headers.delete("authorization");
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

/** The upstream path of a request: the full path, unchanged. */
export const unchangedPath = (req: ServiceRequest) => req.path;

/**
 * Forwards a request to its route's upstream, streaming the body both ways, and returns the upstream's response with
 * the hop-by-hop headers removed; the request log entry gets `proxy: <route>` once the response body ended.
 */
export async function forwardRequest(req: ServiceRequest, route: ProxyRoute, production: boolean, path = unchangedPath(req)): Promise<Response> {
  const method = req.method;
  const hasBody = method !== "GET" && method !== "HEAD" && req.raw.body !== null;
  let upstream: Response;
  try {
    upstream = await streamCall({
      method,
      path: `${path}${new URL(req.raw.url).search}`,
      headers: forwardedHeaders(req, route),
      ...(hasBody ? { body: req.raw.body! } : {}),
      service: route.service,
      timeout: route.timeoutMs,
      idleTimeout: route.idleTimeoutMs,
      signal: req.raw.signal,
      req,
    });
  } catch (error) {
    throw upstreamError(error, production);
  }
  let ended!: () => void;
  const finished = new Promise<Record<string, unknown>>((resolve) => (ended = () => resolve({ proxy: route.name })));
  const body = upstream.body ? upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => ended() })) : null;
  if (!body) ended();
  const response = new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: withoutHopByHop(upstream.headers) });
  // A cancelled download ends the entry too.
  req.raw.signal.addEventListener("abort", () => ended(), { once: true });
  deferRequestLog(response, finished);
  return response;
}
