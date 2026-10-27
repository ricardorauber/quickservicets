import { DEFAULT_MASKED_KEYS, defineFeature, safeLog, type ErrorMiddleware } from "../public.ts";
import { running, type RunningHttp } from "./client.ts";
import { HttpClientError } from "./errors.ts";
import { httpOptions, type HttpOptions } from "./options.ts";
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
  validate: (options) => allowProblems(options.allow),
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
    };
    running.current = settings;
    ctx.app.onStop(() => {
      if (running.current === settings) running.current = undefined;
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
});

export default httpFeature;
export { httpFeature };
export { http, HttpRequestBuilder } from "./client.ts";
export type { Http, HttpBody, HttpMethods, HttpModifier, HttpQueryValue, HttpRequest, HttpResponse } from "./client.ts";
export { HttpClientError } from "./errors.ts";
export { blockedCategory, useTestResolver } from "./ssrf.ts";
export type { TestResolverMap } from "./ssrf.ts";
export type { HttpClientErrorCode, HttpClientErrorInit } from "./errors.ts";
