import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notifyRequestObservers, observeRequests, type RequestObservation } from "./request-observers.ts";
import { UsageRecorder, type Dimension, type RecorderSettings, type RouteSlot, type UsageObservation, type UsageWindow } from "./features/metrics/windows.ts";

const START = Date.parse("2026-10-28T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const ROUTES: [string, string | null][] = [
  ["GET", "/users/[id]"],
  ["GET", "/users"],
  ["POST", "/users"],
  ["PATCH", "/users/[id]"],
  ["DELETE", "/users/[id]"],
  ["GET", "/posts/feed"],
  ["PUT", "/files/[...rest]"],
  ["GET", null],
  ["POST", null],
];
const TENANTS = [undefined, "acme", "globex"];
const USERS = [undefined, "u1", "u2", "u3"];
const STATUSES = [200, 200, 200, 201, 204, 304, 101, 400, 404, 429, 500, 503];

/** Seeded requests: every route, tenant, user and status class, latencies from 0.01 ms to over an hour. */
function seededRequests(count: number, seed = 7) {
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) + 0.5) / 2_147_483_648;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  return Array.from({ length: count }, (_, index) => {
    const [method, route] = pick(ROUTES);
    const tenantId = pick(TENANTS);
    const userId = pick(USERS);
    const roll = random();
    const durationMs = index % 997 === 0 ? 5 * HOUR : roll < 0.02 ? random() * 0.1 : Math.exp(1 + Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
    return { method, route, status: pick(STATUSES), durationMs, ...(tenantId !== undefined ? { tenantId } : {}), ...(userId !== undefined ? { userId } : {}) };
  });
}

const settingsOf = (by: Dimension[], maxSeries = 10_000): RecorderSettings => ({ windowMs: MINUTE, retentionMs: 2 * HOUR, rollupMs: HOUR, rollupRetentionMs: 7 * 24 * HOUR, by, maxSeries, onOverflow: () => {} });

/** The recorded series of a window, in insertion order, with their counts, sketches and quantiles. */
function snapshot(window: UsageWindow) {
  return [...window.series].map(([key, series]) => ({
    key,
    route: series.route,
    tenant: series.tenant,
    user: series.user,
    requests: series.requests,
    errors: series.errors,
    clientErrors: series.clientErrors,
    classes: [...series.classes],
    count: series.sketch.count,
    sum: series.sketch.sum,
    max: series.sketch.max,
    buckets: series.sketch.counts.size,
    p50: series.sketch.quantile(0.5),
    p95: series.sketch.quantile(0.95),
    p99: series.sketch.quantile(0.99),
  }));
}

/** Records a request as the recorder's callers do: by its dimensions, or through the slot of its method and route. */
type RecordWith = (recorder: UsageRecorder, request: UsageObservation, by?: Dimension[]) => void;
const byDimensions: RecordWith = (recorder, request, by) => recorder.record(request, by);
const slots = new WeakMap<UsageRecorder, Map<string, RouteSlot>>();
const throughSlots: RecordWith = (recorder, request, by) => {
  let kept = slots.get(recorder);
  if (!kept) slots.set(recorder, (kept = new Map()));
  const name = `${request.method} ${request.route} ${by?.join() ?? "default"}`;
  let slot = kept.get(name);
  if (!slot) kept.set(name, (slot = recorder.slot(request.method, request.route, by)));
  recorder.recordIn(slot, request);
};

/** The scenarios of the fixture: each records the seeded requests into one window and snapshots it. */
function scenarios(record: RecordWith = byDimensions) {
  const requests = seededRequests(6000);
  const byRouteTenant = new UsageRecorder(settingsOf(["route", "tenant"]), START);
  const byAll = new UsageRecorder(settingsOf(["route", "tenant", "user"]), START);
  const tagged = new UsageRecorder(settingsOf(["route", "tenant", "user"]), START);
  const overflow = new UsageRecorder(settingsOf(["route", "tenant"], 7), START);
  requests.forEach((request, index) => {
    record(byRouteTenant, request);
    record(byAll, request);
    // Routes tagged with fewer dimensions record under their own list, as `@metrics by=...` does.
    record(tagged, request, index % 3 === 0 ? ["route"] : index % 3 === 1 ? ["route", "user"] : undefined);
    record(overflow, request);
  });
  return {
    routeTenant: snapshot(byRouteTenant.current),
    routeTenantUser: snapshot(byAll.current),
    perRouteDimensions: snapshot(tagged.current),
    overflow: snapshot(overflow.current),
  };
}

/** The snapshots recorded before the recording path was made cheaper; `scenarios()` must still produce them. */
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "metrics-recording.json"), "utf8")) as ReturnType<typeof scenarios>;

describe("recording parity", () => {
  test("the same requests give the same series keys, counts and p50, p95 and p99 as the recorded fixture", () => {
    for (const now of [scenarios(byDimensions), scenarios(throughSlots)]) {
      for (const name of ["routeTenant", "routeTenantUser", "perRouteDimensions", "overflow"] as const) {
        expect(now[name].length).toBeGreaterThan(0);
        expect(now[name].map((series) => series.key)).toEqual(fixture[name].map((series) => series.key));
        expect(now[name]).toEqual(fixture[name]);
      }
    }
    expect(fixture.overflow.at(-1)).toMatchObject({ route: "other", tenant: "other" });
  });
});

describe("windows of a batch", () => {
  test("requests of one microtask batch and across window boundaries are each counted in the window open when they are recorded", async () => {
    const usage = new UsageRecorder(settingsOf(["route", "tenant"]), START);
    // Requests of /a go through their route's slot, as the metrics native records them, and those of /b by dimensions.
    const stop = observeRequests((observation) => (observation.route === "/a" ? throughSlots : byDimensions)(usage, observation));
    const observation = (route: string, tenantId?: string): RequestObservation => ({ method: "GET", route, status: 200, durationMs: 5, startedAt: START, ...(tenantId ? { tenantId } : {}) });
    const counts = (window: UsageWindow) => Object.fromEntries([...window.series.values()].map((series) => [`${series.route} ${series.tenant}`, series.requests]));
    try {
      for (let index = 0; index < 500; index++) notifyRequestObservers(observation(index % 2 === 0 ? "/a" : "/b", index % 5 === 0 ? "acme" : undefined));
      expect(usage.current.series.size).toBe(0);
      await Promise.resolve();
      expect(counts(usage.current)).toEqual({ "GET /a -": 200, "GET /a acme": 50, "GET /b -": 200, "GET /b acme": 50 });

      // The next window starts empty, though the same series were looked up in the last one.
      usage.rotate(START + MINUTE);
      for (let index = 0; index < 300; index++) notifyRequestObservers(observation("/a", index < 100 ? "acme" : undefined));
      await Promise.resolve();
      usage.rotate(START + 3 * MINUTE);
      usage.record(observation("/b"));
      const [first, second] = usage.closed;
      expect(first!.start).toBe(START);
      expect(counts(first!)).toEqual({ "GET /a -": 200, "GET /a acme": 50, "GET /b -": 200, "GET /b acme": 50 });
      expect(second!.start).toBe(START + MINUTE);
      expect(counts(second!)).toEqual({ "GET /a acme": 100, "GET /a -": 200 });
      expect(usage.current.start).toBe(START + 3 * MINUTE);
      expect(counts(usage.current)).toEqual({ "GET /b -": 1 });
      const total = [first!, second!, usage.current].flatMap((window) => [...window.series.values()]).reduce((sum, series) => sum + series.sketch.count, 0);
      expect(total).toBe(801);
    } finally {
      stop();
    }
  });
});
