import { DEFAULT_MASKED_KEYS, defineFeature, maskSecrets, resolveOptions, safeLog, setContextHttp, type ErrorMiddleware } from "../public.ts";
import type { HttpApi } from "./api.ts";
import { builtInModifiers, clientOf, configServices, modifierNamed, requestClient, running, serviceSettings, type RegisteredModifier, type RunningHttp, type ServiceSettings } from "./client.ts";
import { isModifier } from "./modifiers.ts";
import { HttpClientError } from "./errors.ts";
import { httpOptions, serviceOptions, serviceProblems, type HttpOptions, type ServiceOptions } from "./options.ts";
import { allowProblems } from "./ssrf.ts";

/** The answer an endpoint gives an `HttpClientError` it lets escape. */
export function upstreamAnswer(error: HttpClientError, production: boolean): Response {
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
  docs: { summary: "A fluent, typed client for calling other HTTP services, with timeouts, size limits and clear errors by default." },
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
    },
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

/** The named modifiers of each running configuration, which features add to. */
const modifiers = new WeakMap<object, Map<string, RegisteredModifier>>();

/** The services of each running configuration, which features add to. */
const services = new WeakMap<object, Map<string, ServiceSettings>>();

export default httpFeature;
export { httpFeature };
export { http, HttpRequestBuilder } from "./client.ts";
export type { HttpApi } from "./api.ts";
export type { ServiceOptions, ServiceOptionsInput } from "./options.ts";
export type { Http, HttpBody, HttpMethods, HttpServiceMethods, HttpServiceNames, ServiceName, HttpModifier, HttpQueryValue, HttpRequest, HttpResponse } from "./client.ts";
export { HttpClientError } from "./errors.ts";
export { blockedCategory, useTestResolver } from "./ssrf.ts";
export { defineModifier } from "./modifiers.ts";
export type { ModifierFunction } from "./modifiers.ts";
export { withRetry } from "./retry.ts";
export type { RetryOptions } from "./retry.ts";
export type { TestResolverMap } from "./ssrf.ts";
export type { HttpClientErrorCode, HttpClientErrorInit } from "./errors.ts";
