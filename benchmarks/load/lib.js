// Shared helpers for the k6 scenarios. Every scenario runs a fixed number of VUs for a fixed duration;
// run.ts runs it twice per stack: once as warmup (summary discarded), then the measured run.
//
// Environment:
//   BASE_URL     service under test (default http://localhost:8080)
//   VUS          concurrent virtual users (default 64)
//   DURATION     run length (default 30s)
//   FIXTURES     path of the seeded ids JSON (default /fixtures/fixtures.json)
//   SUMMARY_OUT  where handleSummary writes the JSON summary (default /out/summary.json)
//   RUN_ID       makes generated emails unique across runs (default: start time)
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
export const RUN_ID = __ENV.RUN_ID || String(Date.now());

const errors = new Rate("errors");
const unexpected = new Counter("unexpected_status");

/** k6 options for a scenario whose requests are tagged with the given endpoint names. */
export function options(endpoints) {
  const thresholds = {
    // Thresholds that always pass, declared so the summary keeps per-endpoint sub-metrics.
    http_req_duration: ["max>=0"],
    errors: ["rate>=0"],
  };
  for (const endpoint of endpoints) {
    thresholds[`http_req_duration{endpoint:${endpoint}}`] = ["max>=0"];
    thresholds[`http_reqs{endpoint:${endpoint}}`] = ["count>=0"];
    thresholds[`errors{endpoint:${endpoint}}`] = ["rate>=0"];
  }
  return {
    vus: Number(__ENV.VUS || 64),
    duration: __ENV.DURATION || "30s",
    discardResponseBodies: true,
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(99)", "max"],
    thresholds,
    // Connections are reused across iterations, as a real client pool would do.
    noConnectionReuse: false,
    insecureSkipTLSVerify: true,
  };
}

export function loadFixtures() {
  return JSON.parse(open(__ENV.FIXTURES || "/fixtures/fixtures.json"));
}

/** Records the outcome of one request: an error is any status other than the expected one. */
export function expectStatus(res, status, endpoint) {
  const ok = res.status === status;
  errors.add(!ok, { endpoint });
  if (!ok) unexpected.add(1, { endpoint, status: String(res.status) });
  check(res, { [`${endpoint} is ${status}`]: () => ok });
  return ok;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export const JSON_HEADERS = { "content-type": "application/json" };

function metric(data, name) {
  return data.metrics[name] ? data.metrics[name].values : undefined;
}

function stats(data, suffix) {
  const duration = metric(data, `http_req_duration${suffix}`);
  const reqs = metric(data, `http_reqs${suffix}`);
  const errs = metric(data, `errors${suffix}`);
  if (!duration || !reqs) return undefined;
  const seconds = data.state.testRunDurationMs / 1000;
  return {
    requests: reqs.count,
    reqPerSec: reqs.count / seconds,
    latencyMs: {
      avg: duration.avg,
      p50: duration.med,
      p90: duration["p(90)"],
      p99: duration["p(99)"],
      max: duration.max,
    },
    errorRate: errs ? errs.rate : 0,
  };
}

/** Writes a compact JSON summary: totals plus one entry per tagged endpoint. */
export function summary(data) {
  const endpoints = {};
  for (const name of Object.keys(data.metrics)) {
    const match = /^http_req_duration\{endpoint:(.+)\}$/.exec(name);
    if (match) endpoints[match[1]] = stats(data, `{endpoint:${match[1]}}`);
  }
  const iterations = metric(data, "iterations");
  const result = {
    vus: Number(__ENV.VUS || 64),
    durationMs: data.state.testRunDurationMs,
    iterations: iterations ? iterations.count : 0,
    ...stats(data, ""),
    endpoints,
  };
  const out = __ENV.SUMMARY_OUT || "/out/summary.json";
  return { [out]: JSON.stringify(result, null, 2), stdout: `${JSON.stringify(result)}\n` };
}
