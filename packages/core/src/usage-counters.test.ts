import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { metricWindowEntity } from "./features/metrics/model.ts";
import { queryWindows } from "./features/metrics/query.ts";
import { databaseMetricsStore, storedWindow, usageWindow } from "./features/metrics/store.ts";
import { mergeWindowInto, UsageRecorder, type RecorderSettings } from "./features/metrics/windows.ts";

const NOW = Date.parse("2026-11-03T10:00:30Z");
const settings = (overrides: Partial<RecorderSettings> = {}): RecorderSettings => ({
  windowMs: 60_000,
  retentionMs: 7_200_000,
  rollupMs: 3_600_000,
  rollupRetentionMs: 604_800_000,
  by: ["route", "tenant"],
  maxSeries: 3,
  onOverflow() {},
  ...overrides,
});

describe("usage sums", () => {
  test("two workers' sums of one minute add up in the database store, and rollups keep them", async () => {
    const adapter = memoryAdapter();
    const model = metricWindowEntity();
    await adapter.connect([model]);
    const store = databaseMetricsStore(adapter, model);
    const a = new UsageRecorder(settings(), NOW);
    const b = new UsageRecorder(settings(), NOW);
    a.addUsage("test.items", 2, { route: "GET /posts", tenant: "acme" });
    b.addUsage("test.items", 5, { route: "GET /posts", tenant: "acme" });
    await store.write([storedWindow(a.current, "a"), storedWindow(b.current, "b")]);
    // A repeated flush replaces the row, never doubling it.
    await store.write([storedWindow(a.current, "a")]);
    const windows = (await store.read({ from: new Date(NOW - 3_600_000), to: new Date(NOW + 60_000) })).map(usageWindow);
    const result = await queryWindows(windows, settings(), { from: new Date(NOW - 60_000), to: new Date(NOW + 60_000) }, NOW);
    expect(result.totals.usage).toEqual({ "test.items": 7 });
    expect(result.series[0]).toMatchObject({ route: "GET /posts", tenant: "acme", usage: { "test.items": 7 } });
    const rolled = await store.rollup({ before: new Date(NOW + 60_000), pruneBefore: new Date(0), rollupMs: 3_600_000 });
    expect(rolled.rolled).toBe(2);
    const hours = (await store.read({ from: new Date(NOW - 3_600_000), to: new Date(NOW + 3_600_000) })).map(usageWindow);
    const merged = await queryWindows(hours, settings(), { from: new Date(NOW - 3_600_000), to: new Date(NOW + 3_600_000) }, NOW);
    expect(merged.totals.usage).toEqual({ "test.items": 7 });
  });

  test("usage-only series count toward maxSeries and overflow into other; in-memory rollups sum them", () => {
    const recorder = new UsageRecorder(settings({ maxSeries: 2 }), NOW);
    recorder.addUsage("x", 1, { route: "a" });
    recorder.addUsage("x", 1, { route: "b" });
    recorder.addUsage("x", 4, { route: "c" });
    const other = [...recorder.current.series.values()].find((series) => series.route === "other")!;
    expect(other.usage).toEqual({ x: 4 });
    const target = { start: 0, resolution: "hour" as const, series: new Map() };
    mergeWindowInto(target, recorder.current);
    mergeWindowInto(target, recorder.current);
    expect([...target.series.values()].reduce((sum, series) => sum + (series.usage?.x ?? 0), 0)).toBe(12);
  });

  test("without counters a series has no usage field", () => {
    const recorder = new UsageRecorder(settings(), NOW);
    recorder.record({ method: "GET", route: "/posts", status: 200, durationMs: 1 });
    expect([...recorder.current.series.values()][0]).not.toHaveProperty("usage");
  });
});
