import { DEFAULT_MASKED_KEYS, defineFeature, maskSecrets, parseDuration, resolveOptions, safeLog, setContextHttp, type ErrorMiddleware, type Logger } from "../public.ts";
import { loadServiceTls, ServiceTlsWatcher, type ServiceTls } from "./service-tls.ts";
import type { HttpApi } from "./api.ts";
import { builtInModifiers, clientOf, configServices, modifierNamed, requestClient, running, serviceSettings, type RegisteredModifier, type RunningHttp, type ServiceSettings } from "./client.ts";
import { isModifier } from "./modifiers.ts";
import { HttpClientError } from "./errors.ts";
import { httpOptions, serviceOptions, serviceProblems, type HttpOptions, type ServiceOptions } from "./options.ts";
import { allowProblems } from "./ssrf.ts";

/** The answer an endpoint gives an `HttpClientError` it lets escape. */
export function upstreamAnswer(error: HttpClientError, production: boolean): Response {
  if (error.code === "CIRCUIT_OPEN" || error.code === "BULKHEAD_FULL") {
    const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
    const details = production ? undefined : { code: error.code, url: error.url, ...(error.service !== undefined ? { service: error.service } : {}) };
    return Response.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "Upstream unavailable", ...(details ? { details } : {}) } },
      { status: 503, ...(retryAfter !== undefined ? { headers: { "retry-after": String(retryAfter) } } : {}) },
    );
  }
  const timeout = error.code === "TIMEOUT";
  const [status, code, message] = timeout ? [504, "GATEWAY_TIMEOUT", "Upstream request timed out"] : [502, "BAD_GATEWAY", "Upstream request failed"];
  const details = production ? undefined : { code: error.code, status: error.status, url: error.url, ...(error.service !== undefined ? { service: error.service } : {}) };
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

/**
 * The `http` native: the outgoing HTTP client `http`, with timeouts, size limits and clear errors. Enabled by default;
 * it costs nothing until code makes a call.
 */
const httpFeature = defineFeature({
  key: "http",
  docs: {
    summary: "A fluent, typed client for calling other HTTP services, with timeouts, size limits and clear errors by default.",
    sections: [
      {
        title: "Named services",
        text: "Every option of a service has its variable, with the service's name in upper case and hyphens as underscores: `QS_HTTP_SERVICES_<NAME>_URL`, `QS_HTTP_SERVICES_<NAME>_TIMEOUT`, `QS_HTTP_SERVICES_<NAME>_AUTH_BEARER`, `QS_HTTP_SERVICES_<NAME>_RETRY_ENABLED`, `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_FAILURES`; `QS_HTTP_SERVICES` sets the whole record as JSON. A variable replaces a per-request function of `headers` or `auth`.",
      },
      {
        title: "Modifiers",
        text: [
          "A modifier wraps calls: `defineModifier((request, next) => ...)` receives the request (`method`, `url`, `headers`, `body`, `timeout`, `signal`, `attempt`, `service`), may change it, calls `next(request?)` any number of times and resolves the response or a replacement. Anything it throws other than an `HttpClientError` fails the call with `MODIFIER_FAILED`.",
          "",
          "Calls run a service's built-in modifiers in the order `retry`, `circuitBreaker`, `bulkhead`, `cache`, then the service's `modifiers` list, then the call's `.use()` modifiers, then the transport with the hooks around it.",
          "",
          "Registered names: `retry` (`withRetry`), `circuitBreaker` (`withCircuitBreaker`), `bulkhead` (`withBulkhead`) and `cache` (`withCache`); features add more with `ctx.feature(\"http\").modifier(name, modifier)`.",
        ].join("\n"),
      },
      {
        title: "HttpTransport",
        text: "`transport` replaces how a request is sent: an object with `fetch(request, { signal, address })` that receives a standard `Request` for the original URL and the address SSRF protection validated (absent with `ssrf: false`), and resolves a standard `Response`. Redirects, size limits, logging and modifiers keep working above it, and `http.mock()` answers instead while it is active.",
      },
      { title: "Tags", text: "The client has no tags: calls are made from code, where every setting is a builder method or a service option." },
      { title: "Files", text: "The client contributes no entities, endpoints, hooks, jobs or folders, so there are no files to override." },
    ],
  },
  options: httpOptions,
  enabledByDefault: true,
  after: ["security"],
  // `req.http` is created on first read only, so a request that makes no call pays nothing.
  request: { http: requestClient },
  validate: (options) => [
    ...allowProblems(options.allow),
    ...Object.entries(options.services as Record<string, ServiceOptions>).flatMap(([name, service]) => serviceProblems(name, service)),
  ],
  setup(ctx) {
    if (!ctx.options.ssrf && ctx.config.production) {
      safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "http.ssrf.disabled", hint: "outgoing calls may reach internal networks and cloud metadata endpoints" });
    }
    const security = ctx.config.features.find((feature) => feature.key === "security");
    const masking = (security?.options as { masking?: { enabled?: boolean; keys?: readonly string[] } } | undefined)?.masking;
    const settings: RunningHttp = {
      options: ctx.options as HttpOptions,
      logger: ctx.logger,
      production: ctx.config.production,
      maskKeys: masking?.enabled && masking.keys ? masking.keys : DEFAULT_MASKED_KEYS,
      services: configServices(ctx.options as HttpOptions),
      modifiers: builtInModifiers(),
    };
    services.set(ctx.options, settings.services as Map<string, ServiceSettings>);
    // Services with tls: their files are read and checked now, and watched for renewals.
    const tlsEntries = new Map<string, { options: NonNullable<ServiceOptions["tls"]>; material: ServiceTls }>();
    tlsStates.set(ctx.options, { entries: tlsEntries, logger: ctx.logger, production: ctx.config.production });
    for (const service of settings.services.values()) addServiceTls(ctx.options, service.name, service.tls as ServiceOptions["tls"]);
    settings.tls = new Map([...tlsEntries].map(([name, entry]) => [name, entry.material]));
    let watcher: ServiceTlsWatcher | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const onHangup = () => watcher?.check();
    ctx.app.onStart(() => {
      settings.tls = new Map([...tlsEntries].map(([name, entry]) => [name, entry.material]));
      if (tlsEntries.size === 0) return;
      watcher = new ServiceTlsWatcher(tlsEntries, ctx.logger);
      if (!watcher.watching) return;
      timer = setInterval(() => watcher!.check(), parseDuration(ctx.options.tlsReloadInterval) ?? 60_000);
      process.on("SIGHUP", onHangup);
    });
    ctx.app.onStop(() => {
      if (timer) clearInterval(timer);
      process.off("SIGHUP", onHangup);
    });
    modifiers.set(ctx.options, settings.modifiers as Map<string, RegisteredModifier>);
    // Once every feature registered its modifiers, each service's list must name registered ones.
    ctx.app.onStart(() => {
      for (const service of settings.services.values()) for (const name of (service.modifiers as string[] | undefined) ?? []) modifierNamed(name, service.name, settings);
    });
    running.current = settings;
    // Jobs and queue consumers get a client sending their run or message id.
    const contextClient = (requestId: string) => clientOf({ requestId });
    setContextHttp(contextClient);
    ctx.app.onStop(() => {
      if (running.current === settings) running.current = undefined;
      setContextHttp(undefined);
    });
    // An outgoing call that fails and escapes a handler answers 502, or 504 for a timeout, instead of 500.
    const middleware: ErrorMiddleware = {
      stage: "error",
      run(error) {
        return error instanceof HttpClientError ? upstreamAnswer(error, ctx.config.production) : undefined;
      },
    };
    ctx.app.use(middleware);
  },
  api: (ctx): HttpApi => ({
    addService(name, input) {
      const owner = ctx.currentFeature();
      if (owner === undefined) throw new Error("http addService() can only be called during setup");
      const full = name === owner || name.startsWith(`${owner}/`) ? name : `${owner}/${name}`;
      const registered = services.get(ctx.options)!;
      const taken = registered.get(full);
      if (taken) throw new Error(`Service ${full} is declared by ${taken.owner} and ${owner}`);
      const resolved = resolveOptions(serviceOptions, input, `http.services.${full}`) as ServiceOptions;
      const problems = serviceProblems(full, resolved);
      if (problems.length > 0) throw new Error(problems.join("\n"));
      const auth = resolved.auth as Record<string, unknown> | undefined;
      if (auth) maskSecrets(resolved as Record<string, unknown>, ["auth.bearer", "auth.basic.password", "auth.apiKey.value"].filter((path) => path.split(".").slice(1).reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], auth) !== undefined));
      registered.set(full, serviceSettings(full, owner, resolved));
      addServiceTls(ctx.options, full, resolved.tls);
    },
    beforeRequest: (fn) => ctx.addHook("beforeRequest", fn as never),
    afterResponse: (fn) => ctx.addHook("afterResponse", fn as never),
    onError: (fn) => ctx.addHook("onError", fn as never),
    modifier(name, modifier) {
      const owner = ctx.currentFeature();
      if (owner === undefined) throw new Error("http modifier() can only be called during setup");
      if (!isModifier(modifier)) throw new TypeError(`http modifier(${JSON.stringify(name)}) takes a modifier made with defineModifier()`);
      const registered = modifiers.get(ctx.options)!;
      const taken = registered.get(name);
      if (taken) throw new Error(`HTTP modifier ${name} is registered by ${taken.owner} and ${owner}`);
      registered.set(name, { owner, modifier });
    },
  }),
});

/** The TLS state of each running configuration: the services' material and how to log about it. */
const tlsStates = new WeakMap<object, { entries: Map<string, { options: NonNullable<ServiceOptions["tls"]>; material: ServiceTls }>; logger: Logger; production: boolean }>();

/**
 * Reads a service's TLS options: `rejectUnauthorized: false` is refused in production and warned about once outside
 * it, and the files are read and checked now.
 */
function addServiceTls(options: object, name: string, tls: ServiceOptions["tls"] | undefined): void {
  const state = tlsStates.get(options);
  if (!state || !tls) return;
  if (tls.rejectUnauthorized === false) {
    if (state.production) throw new Error(`http.services.${name}.tls.rejectUnauthorized cannot be false in production`);
    safeLog(state.logger, "warn", { timestamp: new Date().toISOString(), message: "http.tls.insecure", service: name, hint: "the service's certificate is not verified" });
  }
  state.entries.set(name, { options: tls, material: loadServiceTls(name, tls) });
}

/** The named modifiers of each running configuration, which features add to. */
const modifiers = new WeakMap<object, Map<string, RegisteredModifier>>();

/** The services of each running configuration, which features add to. */
const services = new WeakMap<object, Map<string, ServiceSettings>>();

export default httpFeature;
export { httpFeature };
export { http, HttpRequestBuilder, joinPath, serviceUrl, streamCall } from "./client.ts";
export type { StreamCallSpec } from "./client.ts";
export type { HttpApi } from "./api.ts";
export type { ServiceOptions, ServiceOptionsInput } from "./options.ts";
export type { Http, HttpBody, HttpMethods, HttpServiceMethods, HttpServiceNames, ServiceName, HttpModifier, HttpQueryValue, HttpRequest, HttpResponse } from "./client.ts";
export { HttpClientError } from "./errors.ts";
export { blockedCategory, useTestResolver } from "./ssrf.ts";
export { defineModifier } from "./modifiers.ts";
export type { ModifierFunction } from "./modifiers.ts";
export { withRetry } from "./retry.ts";
export { withBulkhead, withCircuitBreaker } from "./resilience.ts";
export { withCache } from "./cache.ts";
export { mockHttp } from "./mock.ts";
export type { HttpTransport } from "./transport.ts";
export type { HttpMock, MockCall, MockHandler, MockReply, MockRequest, MockService } from "./mock.ts";
export type { CacheOptions } from "./cache.ts";
export type { BulkheadOptions, CircuitBreakerOptions, HttpState } from "./resilience.ts";
export type { RetryOptions } from "./retry.ts";
export type { TestResolverMap } from "./ssrf.ts";
export type { HttpClientErrorCode, HttpClientErrorInit } from "./errors.ts";
