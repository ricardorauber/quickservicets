import { anyOf, boolean, CORE_VERSION, duration, hook, integer, list, object, oneOf, provider, record, secret, size, string, toggle, url, type Options, type OptionsInput } from "../public.ts";
import type { HttpRequest, HttpResponse } from "./client.ts";
import type { HttpClientError } from "./errors.ts";
import type { HttpTransport } from "./transport.ts";

/** What a service name looks like. */
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;

/** The options of one named service. */
export const serviceOptions = object({
  url: url().describe("The service's base URL; call paths are joined to its path, like https://billing.internal/v1."),
  headers: record(string().describe("The value of the header."))
    .optional()
    .perRequest()
    .describe("Headers sent with every call to the service, under the headers the call sets; a function of the call context (req, user, tenant and service) computes them on each call."),
  auth: object({
    bearer: secret().optional().describe("Sends the token as authorization: Bearer."),
    basic: object({
      username: string().describe("The user name."),
      password: secret().describe("The password."),
    })
      .optional()
      .describe("Sends authorization: Basic with the user name and password."),
    apiKey: object({
      header: string().default("x-api-key").describe("The header that carries the key."),
      value: secret().describe("The key."),
    })
      .optional()
      .describe("Sends the key in a header."),
  })
    .optional()
    .perRequest()
    .describe("How calls to the service authenticate: one of bearer, basic or apiKey; a function of the call context (req, user, tenant and service) computes it on each call."),
  timeout: duration().optional().describe("The timeout of calls to the service, instead of http.timeout."),
  propagate: list(oneOf(["user", "tenant", "authorization"]))
    .default([])
    .describe("What calls through req.http carry from the request: user sends x-user-id, tenant sends x-tenant-id, authorization forwards the incoming authorization header."),
  log: oneOf(["all", "errors", "off"]).optional().describe("Which calls to the service write http.call entries, instead of http.log."),
  retry: toggle({
    attempts: integer().min(1).default(3).describe("Attempts in total, the first included."),
    backoff: duration().default("200ms").describe("The first backoff, doubled for each next attempt, with full jitter."),
    maxBackoff: duration().default("5s").describe("The longest backoff."),
    methods: list(oneOf(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "POST", "PATCH"]))
      .default(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
      .describe("The methods retried; POST and PATCH are also retried when the request has an Idempotency-Key header."),
    on: list(anyOf(integer().min(100).max(599), oneOf(["NETWORK", "TIMEOUT"])))
      .default([408, 429, 502, 503, 504, "NETWORK", "TIMEOUT"])
      .describe("The statuses and error codes retried."),
    maxRetryAfter: duration().default("30s").describe("The longest Retry-After waited; a longer one is not retried."),
  })
    .default(false)
    .describe("Retries calls to the service that are safe to retry."),
  circuitBreaker: toggle({
    failures: integer().min(1).default(5).describe("Failures (5xx, network failures, timeouts) within the window that open the circuit."),
    window: duration().default("30s").describe("The rolling window failures are counted in."),
    cooldown: duration().default("30s").describe("How long an open circuit rejects calls before one trial call."),
  })
    .default(false)
    .describe("Stops calling the service for a while after repeated failures."),
  bulkhead: toggle({
    concurrency: integer().min(1).default(10).describe("Calls to the service running at once in a worker."),
    queue: integer().min(0).default(100).describe("Calls waiting for a slot."),
    queueTimeout: duration().default("5s").describe("The longest a call waits for a slot; the wait counts toward its timeout."),
  })
    .default(false)
    .describe("Caps how many calls to the service run at once."),
  cache: toggle({
    ttl: duration().default("60s").describe("How long a response without max-age stays fresh."),
    maxTtl: duration().default("1h").describe("The longest a response stays fresh, whatever its max-age."),
    maxEntries: integer().min(1).default(1000).describe("Responses kept per worker; the least recently used is evicted."),
    maxEntrySize: size().default("1MB").describe("The largest body stored; a larger one passes through."),
    private: boolean().default(false).describe("Caches calls with authorization or cookie headers, keyed by a hash of them, and Cache-Control: private responses."),
  })
    .default(false)
    .describe("Keeps GET and HEAD responses of the service in memory, following its caching headers."),
  modifiers: list(string()).default([]).describe("Registered modifiers that wrap every call to the service, in order, inside the built-in ones."),
});

/** The resolved options of one named service. */
export type ServiceOptions = Options<typeof serviceOptions>;

/** The options a named service is declared with. */
export type ServiceOptionsInput = OptionsInput<typeof serviceOptions>;

/** The problem of a service's options beyond their schema: more than one authentication method. */
export function serviceProblems(name: string, service: Pick<ServiceOptions, "auth">): string[] {
  if (typeof service.auth === "function") return [];
  const methods = ["bearer", "basic", "apiKey"].filter((method) => (service.auth as Record<string, unknown> | undefined)?.[method] !== undefined);
  return methods.length > 1 ? [`Invalid http.services.${name}.auth: use only one of bearer, basic or apiKey`] : [];
}

/** The options of the `http` native. */
export const httpOptions = object({
  timeout: duration().default("10s").describe("The longest an outgoing call may take, reading the response body included; a call sets its own with .timeout()."),
  maxResponseSize: size().default("10MB").describe("The largest response body a call reads; a larger one fails the call with RESPONSE_TOO_LARGE."),
  userAgent: string()
    .default(`quickservicets/${CORE_VERSION}`)
    .describe("The user-agent header of every outgoing call, unless the call sets one."),
  ssrf: boolean()
    .default(true)
    .describe("Blocks calls to internal networks, the machine itself and cloud metadata endpoints, checking every resolved address and every redirect."),
  allow: list(string())
    .default([])
    .describe("Addresses, CIDR blocks (or loopback, private, linklocal) and host names like billing.internal or *.internal that SSRF protection lets through."),
  maxRedirects: integer().min(0).max(20).default(5).describe("How many redirects a call follows before it fails with TOO_MANY_REDIRECTS."),
  log: oneOf(["all", "errors", "off"])
    .default("all")
    .describe("Which calls write an http.call log entry: all of them, only failed calls and statuses of 400 and above, or none."),
  beforeRequest: hook<HttpRequest, undefined>().describe(
    "Runs before every attempt next to the transport, with the request; it may return a changed request, and a throw cancels the call with that error.",
  ),
  afterResponse: hook<{ request: HttpRequest; response: HttpResponse; durationMs: number }, undefined>().describe("Runs after every attempt that got a response, with the request, the response and the duration."),
  onError: hook<{ request: HttpRequest; error: HttpClientError }, undefined>().describe("Runs after every attempt that failed, with the request and the HttpClientError."),
  transport: provider<HttpTransport>("HttpTransport", ["fetch"])
    .optional()
    .describe("Replaces how a request is sent: its fetch(request, context) gets a standard Request with the abort signal and the address SSRF protection validated, and resolves a Response."),
  services: record(serviceOptions)
    .keys(SERVICE_NAME, "a service name starts with a lowercase letter and uses lowercase letters, digits and -")
    .describe("The services the project calls, by name, each called with http.service(name)."),
});

/** The resolved options of the `http` native. */
export type HttpOptions = Options<typeof httpOptions> & { enabled: boolean };
