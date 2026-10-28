import type { Series } from "./windows.ts";

/** The bucket bounds of the request duration histogram, in seconds. */
export const PROMETHEUS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** A label value escaped for the text exposition format: backslashes, double quotes and line breaks. */
export const escapeLabel = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labels = (pairs: readonly (readonly [string, string])[]) => `{${pairs.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;

/** The method and route pattern of a series' route dimension (`GET /posts`), or `other` for the overflow series. */
function methodAndRoute(route: string | undefined): [string, string] {
  if (route === undefined) return ["", ""];
  const at = route.indexOf(" ");
  return at < 0 ? [route, route] : [route.slice(0, at), route.slice(at + 1)];
}

const number = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1e9) / 1e9));

/**
 * The Prometheus text exposition (format 0.0.4) of a worker's series since it started: the
 * `quickservicets_http_requests_total` counter by method, route, status class (and tenant when the series carry it), and
 * the `quickservicets_http_request_duration_seconds` histogram by method and route (and tenant), with `worker` on every
 * sample when given.
 */
export function prometheusText(series: readonly Series[], options: { tenant: boolean; worker?: number }): string {
  const worker: (readonly [string, string])[] = options.worker === undefined ? [] : [["worker", String(options.worker)]];
  const lines: string[] = [
    "# HELP quickservicets_http_requests_total HTTP requests served by this worker since it started.",
    "# TYPE quickservicets_http_requests_total counter",
  ];
  // Series of the same method, route and tenant (users merged) share the histogram.
  const histograms = new Map<string, { base: (readonly [string, string])[]; buckets: number[]; sum: number; count: number }>();
  const counters = new Map<string, { pairs: (readonly [string, string])[]; value: number }>();
  for (const entry of series) {
    const [method, route] = methodAndRoute(entry.route);
    const base: (readonly [string, string])[] = [["method", method], ["route", route], ...(options.tenant ? [["tenant", entry.tenant ?? "-"] as const] : [])];
    entry.classes.forEach((count, index) => {
      if (count === 0 || index === 0) return;
      const pairs = [...base.slice(0, 2), ["status_class", `${index}xx`] as const, ...base.slice(2), ...worker];
      const key = labels(pairs);
      const counter = counters.get(key);
      if (counter) counter.value += count;
      else counters.set(key, { pairs, value: count });
    });
    const key = labels(base);
    let histogram = histograms.get(key);
    if (!histogram) histograms.set(key, (histogram = { base, buckets: PROMETHEUS_BUCKETS.map(() => 0), sum: 0, count: 0 }));
    PROMETHEUS_BUCKETS.forEach((bound, index) => (histogram!.buckets[index]! += entry.sketch.countAtMost(bound * 1000)));
    histogram.sum += entry.sketch.sum / 1000;
    histogram.count += entry.sketch.count;
  }
  for (const { pairs, value } of counters.values()) lines.push(`quickservicets_http_requests_total${labels(pairs)} ${value}`);
  lines.push("# HELP quickservicets_http_request_duration_seconds Duration of HTTP requests served by this worker since it started.", "# TYPE quickservicets_http_request_duration_seconds histogram");
  for (const { base, buckets, sum, count } of histograms.values()) {
    PROMETHEUS_BUCKETS.forEach((bound, index) => lines.push(`quickservicets_http_request_duration_seconds_bucket${labels([...base, ["le", String(bound)], ...worker])} ${buckets[index]}`));
    lines.push(`quickservicets_http_request_duration_seconds_bucket${labels([...base, ["le", "+Inf"], ...worker])} ${count}`);
    lines.push(`quickservicets_http_request_duration_seconds_sum${labels([...base, ...worker])} ${number(sum)}`);
    lines.push(`quickservicets_http_request_duration_seconds_count${labels([...base, ...worker])} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}
