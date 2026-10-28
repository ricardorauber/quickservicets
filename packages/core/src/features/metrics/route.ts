import { timingSafeEqual } from "node:crypto";
import { cidrMatcher, HttpError, parseDuration, type Endpoint, type ServiceRequest } from "../public.ts";
import { prometheusText } from "./prometheus.ts";
import type { MetricsFigures, MetricsQuery, MetricsResult } from "./query.ts";
import type { MetricsRuntime } from "./runtime.ts";
import type { Dimension } from "./windows.ts";

const SORTS = ["requests", "errors", "p95", "p99"] as const;
const MAX_LIMIT = 1000;

/** A 400 naming the parameter. */
const invalid = (name: string, reason: string) => new HttpError(400, `Invalid ${name}: ${reason}`, { details: [{ field: name, message: reason }] });

/** The query a `GET /_metrics` request asks for; throws 400 `VALIDATION_ERROR` naming a bad parameter. */
export function parseMetricsQuery(params: URLSearchParams, options: { by: readonly Dimension[]; maxRangeMs: number }): MetricsQuery {
  const query: MetricsQuery = {};
  const from = params.get("from");
  const to = params.get("to");
  const date = (name: string, value: string) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw invalid(name, "expected an ISO 8601 date");
    return new Date(time);
  };
  if (from !== null || to !== null) {
    if (from === null) throw invalid("from", "required with to");
    query.from = date("from", from);
    if (to !== null) query.to = date("to", to);
  } else {
    const last = params.get("last") ?? "15m";
    const ms = parseDuration(last);
    if (ms === undefined || ms <= 0) throw invalid("last", "expected a duration like 15m or 2h");
    if (ms > options.maxRangeMs) throw invalid("last", "longer than metrics.rollup.retention");
    query.last = last;
  }
  const by = params.get("by");
  if (by !== null) {
    const dimensions = by.split(",").map((value) => value.trim()).filter((value) => value !== "");
    for (const dimension of dimensions) if (!options.by.includes(dimension as Dimension)) throw invalid("by", `expected some of ${options.by.join(", ")}`);
    query.by = dimensions as Dimension[];
  }
  const filter: Partial<Record<Dimension, string>> = {};
  for (const dimension of ["route", "tenant", "user"] as const) {
    const value = params.get(dimension);
    if (value !== null) filter[dimension] = value;
  }
  if (Object.keys(filter).length > 0) query.filter = filter;
  const sort = params.get("sort");
  if (sort !== null) {
    if (!(SORTS as readonly string[]).includes(sort)) throw invalid("sort", `expected one of ${SORTS.join(", ")}`);
    query.sort = sort as MetricsQuery["sort"];
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw invalid("limit", `expected an integer from 1 to ${MAX_LIMIT}`);
    query.limit = value;
  }
  return query;
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** The figures of the JSON form: latencies with two decimals and the error rate with four. */
function figures(value: MetricsFigures) {
  return {
    requests: value.requests,
    errors: value.errors,
    clientErrors: value.clientErrors,
    errorRate: value.requests === 0 ? 0 : round(value.errors / value.requests, 4),
    p50: round(value.p50, 2),
    p95: round(value.p95, 2),
    p99: round(value.p99, 2),
    max: round(value.max, 2),
  };
}

/** The JSON body of a query's result. */
export function metricsBody(result: MetricsResult, window: string) {
  return {
    from: result.from.toISOString(),
    to: result.to.toISOString(),
    window,
    totals: figures(result.totals),
    series: result.series.map((series) => ({
      ...(series.route !== undefined ? { route: series.route } : {}),
      ...(series.tenant !== undefined ? { tenant: series.tenant } : {}),
      ...(series.user !== undefined ? { user: series.user } : {}),
      ...figures(series),
    })),
  };
}

/** Whether the request asks for the Prometheus text format: `format=prometheus`, or an `Accept` preferring text. */
export function wantsPrometheus(req: Pick<ServiceRequest, "query" | "headers">): boolean {
  if (req.query.get("format") === "prometheus") return true;
  const accept = req.headers.get("accept");
  if (!accept) return false;
  const types = accept
    .split(",")
    .map((part, index) => {
      const [type, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      const q = Number(params.find((param) => param.startsWith("q="))?.slice(2) ?? "1");
      return { type: type ?? "", q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.q > 0 && ["text/plain", "application/openmetrics-text", "application/json", "*/*", "application/*", "text/*"].includes(entry.type))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  const first = types[0]?.type;
  return first === "text/plain" || first === "application/openmetrics-text" || first === "text/*";
}

/** Who may read the metrics: addresses on `allow` (none means any) and, with a token, its bearer. */
export interface MetricsAccess {
  allow: readonly string[];
  token?: string;
}

/** Checks the caller against the access rules: 403 for an address outside `allow`, 401 without the token. */
export function checkAccess(req: ServiceRequest, access: MetricsAccess, allowed: ((address: string) => boolean) | undefined): void {
  if (allowed && !allowed(req.ip)) throw new HttpError(403, "Metrics are not available from this address");
  if (access.token === undefined) return;
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(access.token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, "Authentication required");
}

/** The handler of `GET <path>`: access rules first, then the JSON form or the Prometheus exposition. */
export function metricsEndpoint(runtime: () => MetricsRuntime | undefined, settings: { access: MetricsAccess; window: string; by: readonly Dimension[]; maxRangeMs: number; worker?: number }): Endpoint {
  const allowed = settings.access.allow.length > 0 ? cidrMatcher(settings.access.allow) : undefined;
  return async (_repos, req) => {
    checkAccess(req, settings.access, allowed);
    const running = runtime();
    if (!running) throw new HttpError(503, "Metrics are not running");
    if (wantsPrometheus(req)) {
      const text = prometheusText(running.sinceStart(), { tenant: settings.by.includes("tenant"), ...(settings.worker !== undefined ? { worker: settings.worker } : {}) });
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    }
    const query = parseMetricsQuery(req.query, settings);
    return metricsBody(await running.query(query), settings.window);
  };
}
