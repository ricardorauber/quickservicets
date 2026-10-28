import { describe, expect, test } from "bun:test";
import "./index.ts";
import { LatencySketch, BUCKETS } from "./features/metrics/sketch.ts";
import { UsageRecorder, type RecorderSettings } from "./features/metrics/windows.ts";
import { queryWindows } from "./features/metrics/query.ts";

const START = Date.parse("2026-10-28T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;

const recorder = (changes: Partial<RecorderSettings> = {}, overflows: number[] = []) =>
  new UsageRecorder({ windowMs: MINUTE, retentionMs: 2 * HOUR, rollupMs: HOUR, rollupRetentionMs: 7 * 24 * HOUR, by: ["route", "tenant"], maxSeries: 10_000, onOverflow: (limit) => overflows.push(limit), ...changes }, START);

const request = (method: string, route: string | null, status = 200, extra: { userId?: string; tenantId?: string; durationMs?: number } = {}) => ({ method, route, status, durationMs: extra.durationMs ?? 10, ...extra });

describe("the sketch", () => {
  /** A log-normal sample from a seeded generator. */
  const logNormal = (count: number) => {
    let seed = 42;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) + 0.5) / 2_147_483_648;
    return Array.from({ length: count }, () => Math.exp(3 + Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())));
  };
  const exact = (sorted: number[], q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;

  test("p50, p95 and p99 are within 1% of the exact values, also after merging two halves, with at most 2048 buckets", () => {
    const values = logNormal(100_000);
    const sorted = [...values].sort((a, b) => a - b);
    const whole = new LatencySketch();
    const first = new LatencySketch();
    const second = new LatencySketch();
    values.forEach((value, index) => {
      whole.add(value);
      (index % 2 === 0 ? first : second).add(value);
    });
    const merged = first.merge(second);
    for (const sketch of [whole, merged]) {
      for (const q of [0.5, 0.95, 0.99]) expect(Math.abs(sketch.quantile(q) - exact(sorted, q)) / exact(sorted, q)).toBeLessThanOrEqual(0.01);
      expect(sketch.max).toBe(sorted.at(-1)!);
      expect(sketch.count).toBe(100_000);
    }
    expect(BUCKETS).toBeLessThanOrEqual(2048);
    expect(LatencySketch.decode(whole.encode()).quantile(0.95)).toBe(whole.quantile(0.95));
    const bounds = new LatencySketch();
    bounds.add(0.001);
    bounds.add(10 * HOUR);
    expect(bounds.counts.size).toBe(2);
  });
});

describe("series keys", () => {
  test("series are keyed by route and tenant, unmatched routes by method, and users only when asked for", async () => {
    const usage = recorder();
    for (let i = 0; i < 10; i++) usage.record(request("GET", "/posts", i < 2 ? 500 : 200, { tenantId: "acme" }));
    usage.record(request("GET", "/posts", 200, { tenantId: "globex" }));
    usage.record(request("POST", "/posts", 400));
    usage.record(request("DELETE", null, 404));
    const result = await queryWindows(usage.windows(), usage.settings, { last: "5m" }, START + 1000);
    expect(result.series.map(({ route, tenant, requests, errors, clientErrors }) => ({ route, tenant, requests, errors, clientErrors }))).toEqual([
      { route: "GET /posts", tenant: "acme", requests: 10, errors: 2, clientErrors: 0 },
      { route: "GET /posts", tenant: "globex", requests: 1, errors: 0, clientErrors: 0 },
      { route: "POST /posts", tenant: "-", requests: 1, errors: 0, clientErrors: 1 },
      { route: "DELETE unmatched", tenant: "-", requests: 1, errors: 0, clientErrors: 1 },
    ]);
    expect((await queryWindows(usage.windows(), usage.settings, { by: ["route"] }, START + 1000)).series[0]).toMatchObject({ route: "GET /posts", requests: 11 });

    const users = recorder({ by: ["route", "user"] });
    users.record(request("GET", "/me", 200, { userId: "u1" }));
    users.record(request("GET", "/me", 200));
    expect((await queryWindows(users.windows(), users.settings, {}, START + 1000)).series.map((series) => series.user).sort()).toEqual(["-", "u1"]);
  });
});

describe("cardinality", () => {
  test("past maxSeries, new series count in the other series, logged once per window", () => {
    const overflows: number[] = [];
    const usage = recorder({ maxSeries: 2 }, overflows);
    for (const route of ["/a", "/b", "/c", "/d"]) usage.record(request("GET", route));
    expect([...usage.current.series.values()].map((series) => series.route)).toEqual(["GET /a", "GET /b", "other"]);
    expect(usage.current.series.get([...usage.current.series.keys()][2]!)).toMatchObject({ route: "other", tenant: "other", requests: 2 });
    expect(overflows).toEqual([2]);
    usage.rotate(START + MINUTE);
    usage.record(request("GET", "/x"));
    usage.record(request("GET", "/y"));
    usage.record(request("GET", "/z"));
    expect(overflows).toEqual([2, 2]);
  });
});

describe("windows, rollups and query", () => {
  test("windows older than the retention roll into hours, older rollups are dropped, and query still counts every request", async () => {
    const usage = recorder();
    let now = START;
    for (let minute = 0; minute < 180; minute++) {
      usage.record(request("GET", "/posts", 200, { durationMs: 5 + minute }));
      now += MINUTE;
      usage.rotate(now);
    }
    expect(usage.rollups.map((window) => window.resolution)).toEqual(["hour"]);
    expect(usage.rollups[0]!.series.values().next().value!.requests).toBe(60);
    expect(usage.closed.length).toBeLessThanOrEqual(120);
    const all = await queryWindows(usage.windows(), usage.settings, { from: START, to: now }, now);
    expect(all.totals.requests).toBe(180);
    expect(all.totals.max).toBe(184);
    usage.rotate(now + 8 * 24 * HOUR);
    expect(usage.rollups).toEqual([]);
    expect(usage.closed).toEqual([]);
  });
});
