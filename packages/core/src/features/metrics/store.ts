import { runInTransaction, UniqueViolationError, type Condition, type DatabaseAdapter, type EntityModel, type StoredRecord } from "../public.ts";
import { LatencySketch, type EncodedSketch } from "./sketch.ts";
import { emptySeries, mergeSeries, seriesKey, type Dimension, type Resolution, type Series, type UsageWindow } from "./windows.ts";

/** One series of a stored window, with its sketch encoded. */
export interface StoredSeries {
  seriesKey: string;
  route?: string;
  tenant?: string;
  user?: string;
  requests: number;
  errors: number;
  clientErrors: number;
  sketch: EncodedSketch;
}

/** A closed window as stores receive and return it: the worker that recorded it, its resolution, start and series. */
export interface StoredWindow {
  instance: string;
  resolution: Resolution;
  windowStart: Date;
  series: StoredSeries[];
}

/** Where closed windows are kept so every worker and replica reads them all. */
export interface MetricsStore {
  /** Keeps closed windows; writing a window again replaces it, so a repeated write never doubles counts. */
  write(windows: readonly StoredWindow[]): Promise<void>;
  /** The windows starting in a range (`from` inclusive, `to` exclusive). */
  read(range: { from: Date; to: Date }): Promise<StoredWindow[]>;
  /** Deletes the windows of a resolution starting before a time; resolves how many series it deleted. */
  prune(options: { resolution: Resolution; before: Date }): Promise<number>;
}

/** A recorded window as a store receives it. */
export function storedWindow(window: UsageWindow, instance: string): StoredWindow {
  return {
    instance,
    resolution: window.resolution,
    windowStart: new Date(window.start),
    series: [...window.series].map(([key, series]) => ({
      seriesKey: key,
      ...dimensionsOf(series),
      requests: series.requests,
      errors: series.errors,
      clientErrors: series.clientErrors,
      sketch: series.sketch.encode(),
    })),
  };
}

/** A stored window as queries read it. */
export function usageWindow(window: StoredWindow): UsageWindow {
  const series = new Map<string, Series>();
  for (const stored of window.series) {
    const sketch = LatencySketch.decode(stored.sketch);
    series.set(stored.seriesKey, { ...dimensionsOf(stored), requests: stored.requests, errors: stored.errors, clientErrors: stored.clientErrors, classes: [0, 0, 0, 0, 0, 0], sketch });
  }
  return { start: window.windowStart.getTime(), resolution: window.resolution, series };
}

const DIMENSION_NAMES: readonly Dimension[] = ["route", "tenant", "user"];

function dimensionsOf(source: Partial<Record<Dimension, string | null | undefined>>): Partial<Record<Dimension, string>> {
  const dimensions: Partial<Record<Dimension, string>> = {};
  for (const name of DIMENSION_NAMES) {
    const value = source[name];
    if (typeof value === "string") dimensions[name] = value;
  }
  return dimensions;
}

/** Rows written per transaction. */
export const WRITE_BATCH = 500;
/** Rows read, merged or deleted per step of a read or a rollup. */
export const ROLLUP_BATCH = 1000;

const condition = (field: string, op: "eq" | "lt" | "gte" | "in", value: unknown): Condition => ({ field, op, value }) as Condition;

/** The database store of the `MetricWindow` entity, which also rolls minute rows into hour rows. */
export interface DatabaseMetricsStore extends MetricsStore {
  /**
   * Merges the minute rows older than `before` into one hour row per series and instance, deletes them, and deletes the
   * hour rows older than `pruneBefore`, in batches of 1000; safe on several instances at once. Resolves the counts.
   */
  rollup(options: { before: Date; pruneBefore: Date; rollupMs: number }): Promise<{ rolled: number; pruned: number }>;
}

/** The store of the `MetricWindow` entity in the project's database. */
export function databaseMetricsStore(adapter: DatabaseAdapter, model: EntityModel): DatabaseMetricsStore {
  const rowOf = (window: StoredWindow, series: StoredSeries, now: Date): StoredRecord => ({
    id: Bun.randomUUIDv7(),
    createdAt: now,
    updatedAt: now,
    instance: window.instance,
    resolution: window.resolution,
    windowStart: window.windowStart,
    seriesKey: series.seriesKey,
    route: series.route ?? null,
    tenant: series.tenant ?? null,
    user: series.user ?? null,
    requests: series.requests,
    errors: series.errors,
    clientErrors: series.clientErrors,
    sketch: series.sketch as unknown as StoredRecord[string],
  });
  const keyOf = (row: Record<string, unknown>) => [
    condition("instance", "eq", row.instance),
    condition("resolution", "eq", row.resolution),
    condition("windowStart", "eq", row.windowStart),
    condition("seriesKey", "eq", row.seriesKey),
  ];
  /** Inserts a row, or replaces the values of the row with the same key. */
  const upsert = async (row: StoredRecord) => {
    const existing = await adapter.findOne(model, keyOf(row));
    if (existing) {
      await adapter.updateById(model, existing.id, { requests: row.requests, errors: row.errors, clientErrors: row.clientErrors, sketch: row.sketch, updatedAt: row.updatedAt });
      return;
    }
    try {
      await adapter.insert(model, row);
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      const raced = await adapter.findOne(model, keyOf(row));
      if (raced) await adapter.updateById(model, raced.id, { requests: row.requests, errors: row.errors, clientErrors: row.clientErrors, sketch: row.sketch, updatedAt: row.updatedAt });
    }
  };
  /** Every row matching `where`, read in pages. */
  const rowsWhere = async (where: Condition[], limit = Number.POSITIVE_INFINITY): Promise<StoredRecord[]> => {
    const rows: StoredRecord[] = [];
    for (let offset = 0; rows.length < limit; offset += ROLLUP_BATCH) {
      const { data } = await adapter.findMany(model, { where, sort: [{ field: "windowStart", direction: "asc" }, { field: "id", direction: "asc" }], limit: ROLLUP_BATCH, offset, withTotal: false });
      rows.push(...data);
      if (data.length < ROLLUP_BATCH) break;
    }
    return rows;
  };
  const toSeries = (row: StoredRecord): StoredSeries => ({
    seriesKey: row.seriesKey as string,
    ...dimensionsOf(row as Partial<Record<Dimension, string | null>>),
    requests: row.requests as number,
    errors: row.errors as number,
    clientErrors: row.clientErrors as number,
    sketch: row.sketch as unknown as EncodedSketch,
  });
  const store: DatabaseMetricsStore = {
    async write(windows) {
      const now = new Date();
      const rows = windows.flatMap((window) => window.series.map((series) => rowOf(window, series, now)));
      for (let start = 0; start < rows.length; start += WRITE_BATCH) {
        const batch = rows.slice(start, start + WRITE_BATCH);
        await runInTransaction(adapter, async () => {
          for (const row of batch) await upsert(row);
        });
      }
    },
    async read({ from, to }) {
      const rows = await rowsWhere([condition("windowStart", "gte", from), condition("windowStart", "lt", to)]);
      const windows = new Map<string, StoredWindow>();
      for (const row of rows) {
        const start = new Date(row.windowStart as Date);
        const key = `${row.instance as string}\n${row.resolution as string}\n${start.getTime()}`;
        let window = windows.get(key);
        if (!window) windows.set(key, (window = { instance: row.instance as string, resolution: row.resolution as Resolution, windowStart: start, series: [] }));
        window.series.push(toSeries(row));
      }
      return [...windows.values()];
    },
    async prune({ resolution, before }) {
      let deleted = 0;
      for (;;) {
        const { data } = await adapter.findMany(model, { where: [condition("resolution", "eq", resolution), condition("windowStart", "lt", before)], sort: [{ field: "id", direction: "asc" }], limit: ROLLUP_BATCH, offset: 0, withTotal: false });
        for (const row of data) if (await adapter.deleteById(model, row.id)) deleted += 1;
        if (data.length < ROLLUP_BATCH) return deleted;
      }
    },
    async rollup({ before, pruneBefore, rollupMs }) {
      let rolled = 0;
      for (;;) {
        const { data } = await adapter.findMany(model, { where: [condition("resolution", "eq", "minute"), condition("windowStart", "lt", before)], sort: [{ field: "windowStart", direction: "asc" }, { field: "id", direction: "asc" }], limit: ROLLUP_BATCH, offset: 0, withTotal: false });
        if (data.length === 0) break;
        await runInTransaction(adapter, async () => {
          // Each minute row is merged by the instance that deletes it, so concurrent rollups never count one twice.
          const hours = new Map<string, { instance: string; windowStart: Date; series: Series & { seriesKey: string } }>();
          for (const row of data) {
            if (!(await adapter.deleteById(model, row.id))) continue;
            rolled += 1;
            const windowStart = new Date(Math.floor(new Date(row.windowStart as Date).getTime() / rollupMs) * rollupMs);
            const key = `${row.instance as string}\n${windowStart.getTime()}\n${row.seriesKey as string}`;
            const stored = toSeries(row);
            let target = hours.get(key);
            if (!target) hours.set(key, (target = { instance: row.instance as string, windowStart, series: { ...emptySeries(dimensionsOf(stored)), seriesKey: stored.seriesKey } }));
            mergeSeries(target.series, { ...stored, classes: [0, 0, 0, 0, 0, 0], sketch: LatencySketch.decode(stored.sketch) });
          }
          for (const { instance, windowStart, series } of hours.values()) {
            const keyRow = { instance, resolution: "hour", windowStart, seriesKey: series.seriesKey };
            const existing = await adapter.findOne(model, keyOf(keyRow));
            if (existing) {
              await adapter.lockForUpdate?.(model, existing.id);
              const current = (await adapter.findById(model, existing.id)) ?? existing;
              mergeSeries(series, { ...toSeries(current), classes: [0, 0, 0, 0, 0, 0], sketch: LatencySketch.decode(current.sketch as unknown as EncodedSketch) });
              await adapter.updateById(model, existing.id, { requests: series.requests, errors: series.errors, clientErrors: series.clientErrors, sketch: series.sketch.encode() as unknown as StoredRecord[string], updatedAt: new Date() });
            } else {
              const now = new Date();
              await upsert(rowOf({ instance, resolution: "hour", windowStart, series: [] }, { seriesKey: series.seriesKey, ...dimensionsOf(series), requests: series.requests, errors: series.errors, clientErrors: series.clientErrors, sketch: series.sketch.encode() }, now));
            }
          }
        });
        if (data.length < ROLLUP_BATCH) break;
      }
      const pruned = await store.prune({ resolution: "hour", before: pruneBefore });
      return { rolled, pruned };
    },
  };
  return store;
}

/** The key of a series from its stored dimensions. */
export const storedSeriesKey = (series: Partial<Record<Dimension, string>>) => seriesKey(series);
