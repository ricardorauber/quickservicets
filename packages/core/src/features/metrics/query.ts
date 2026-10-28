import { parseDuration } from "../public.ts";
import { DIMENSIONS, emptySeries, mergeSeries, seriesKey, windowSize, type Dimension, type RecorderSettings, type Series, type UsageWindow } from "./windows.ts";

/** What `query` takes: a time range, the dimensions to group by, exact filters, a sort and a limit. */
export interface MetricsQuery {
  /** The start of the range (default: `last` before `to`). */
  from?: Date | number | string;
  /** The end of the range (default: now). */
  to?: Date | number | string;
  /** The length of the range ending at `to`, like `15m` (default `15m`), when `from` is not given. */
  last?: string;
  /** The dimensions to group by, a subset of the configured ones (default: all of them). */
  by?: readonly Dimension[];
  /** Exact values the series must have. */
  filter?: Partial<Record<Dimension, string>>;
  /** The most series returned (default 100). */
  limit?: number;
  /** What the series are sorted by, descending (default `requests`). */
  sort?: "requests" | "errors" | "p95" | "p99";
}

/** The figures of a series or of the totals, latencies in milliseconds. */
export interface MetricsFigures {
  requests: number;
  errors: number;
  clientErrors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** One series of a query's answer, with the dimensions it was grouped by. */
export type MetricsSeries = Partial<Record<Dimension, string>> & MetricsFigures;

/** What `query` resolves. */
export interface MetricsResult {
  from: Date;
  to: Date;
  totals: MetricsFigures;
  series: MetricsSeries[];
}

const time = (value: Date | number | string): number => (value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value));

/** The range of a query, in milliseconds. */
export function rangeOf(query: MetricsQuery, now: number): { from: number; to: number } {
  const to = query.to === undefined ? now : time(query.to);
  const from = query.from === undefined ? to - (parseDuration(query.last ?? "15m") ?? 900_000) : time(query.from);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Invalid metrics query range");
  return { from, to };
}

/** The figures of a series. */
export function figuresOf(series: Pick<Series, "requests" | "errors" | "clientErrors" | "sketch">): MetricsFigures {
  return {
    requests: series.requests,
    errors: series.errors,
    clientErrors: series.clientErrors,
    p50: series.sketch.quantile(0.5),
    p95: series.sketch.quantile(0.95),
    p99: series.sketch.quantile(0.99),
    max: series.sketch.max,
  };
}

/** Lets other requests run while a long merge goes on: every this many series. */
export const YIELD_EVERY = 1000;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Merges the windows overlapping the query's range into series grouped by its dimensions, filtered, sorted and limited,
 * with the totals of every matching series; it yields to the event loop every 1000 series.
 */
export async function queryWindows(windows: readonly UsageWindow[], settings: Pick<RecorderSettings, "windowMs" | "rollupMs" | "by">, query: MetricsQuery, now: number): Promise<MetricsResult> {
  const { from, to } = rangeOf(query, now);
  const by = (query.by ?? settings.by).filter((dimension) => settings.by.includes(dimension));
  const filter = query.filter ?? {};
  const grouped = new Map<string, Series>();
  const total = emptySeries({});
  let seen = 0;
  for (const window of windows) {
    if (window.start > to || window.start + windowSize(window, settings) <= from) continue;
    for (const series of window.series.values()) {
      if (++seen % YIELD_EVERY === 0) await pause();
      if (DIMENSIONS.some((dimension) => filter[dimension] !== undefined && series[dimension] !== filter[dimension])) continue;
      const dimensions: Partial<Record<Dimension, string>> = {};
      for (const dimension of by) if (series[dimension] !== undefined) dimensions[dimension] = series[dimension];
      const key = seriesKey(dimensions);
      let target = grouped.get(key);
      if (!target) grouped.set(key, (target = emptySeries(dimensions)));
      mergeSeries(target, series);
      mergeSeries(total, series);
    }
  }
  const sort = query.sort ?? "requests";
  const limit = query.limit ?? 100;
  const series = [...grouped.values()].map((entry) => {
    const dimensions: Partial<Record<Dimension, string>> = {};
    for (const dimension of DIMENSIONS) if (entry[dimension] !== undefined) dimensions[dimension] = entry[dimension];
    return { ...dimensions, ...figuresOf(entry) };
  });
  series.sort((a, b) => b[sort] - a[sort]);
  return { from: new Date(from), to: new Date(to), totals: figuresOf(total), series: series.slice(0, limit) };
}
