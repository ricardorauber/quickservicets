import { LatencySketch } from "./sketch.ts";

/** A dimension of usage series. */
export type Dimension = "route" | "tenant" | "user";

/** The dimensions in the order series keys hold them. */
export const DIMENSIONS: readonly Dimension[] = ["route", "tenant", "user"];

/** One series of a window: its dimensions, its counts and its latency sketch. */
export interface Series {
  route?: string;
  tenant?: string;
  user?: string;
  requests: number;
  errors: number;
  clientErrors: number;
  /** The requests of each status class, by its first digit (index 1 for 1xx to 5 for 5xx). */
  classes: number[];
  sketch: LatencySketch;
}

/** The resolution of a stored window. */
export type Resolution = "minute" | "hour";

/** The series of one time window, by series key. */
export interface UsageWindow {
  /** The window's start, in milliseconds since the epoch. */
  start: number;
  resolution: Resolution;
  series: Map<string, Series>;
}

/** What `record` needs of a completed request. */
export interface UsageObservation {
  method: string;
  route: string | null;
  status: number;
  durationMs: number;
  userId?: string;
  tenantId?: string;
}

/** The value of a dimension for an observation. */
function valueOf(dimension: Dimension, observation: UsageObservation): string {
  if (dimension === "route") return `${observation.method} ${observation.route ?? "unmatched"}`;
  if (dimension === "tenant") return observation.tenantId ?? "-";
  return observation.userId ?? "-";
}

/** The key of a series from its dimension values. */
export const seriesKey = (series: Pick<Series, Dimension>): string => `${series.route ?? ""}\n${series.tenant ?? ""}\n${series.user ?? ""}`;

/** An empty series with the given dimensions. */
export function emptySeries(dimensions: Pick<Series, Dimension>): Series {
  return { ...dimensions, requests: 0, errors: 0, clientErrors: 0, classes: [0, 0, 0, 0, 0, 0], sketch: new LatencySketch() };
}

/** Adds a series' counts and sketch to another. */
export function mergeSeries(target: Series, source: Series): Series {
  target.requests += source.requests;
  target.errors += source.errors;
  target.clientErrors += source.clientErrors;
  for (let index = 0; index < 6; index++) target.classes[index]! += source.classes[index] ?? 0;
  target.sketch.merge(source.sketch);
  return target;
}

/** The settings of a recorder, in milliseconds. */
export interface RecorderSettings {
  windowMs: number;
  retentionMs: number;
  rollupMs: number;
  rollupRetentionMs: number;
  by: readonly Dimension[];
  maxSeries: number;
  /** Called once per window when it reaches `maxSeries`. */
  onOverflow(limit: number): void;
}

/** The start of the window holding `at`. */
export const windowStart = (at: number, size: number) => Math.floor(at / size) * size;

/**
 * The usage windows of one worker: the open window, recorded into with one map lookup, three increments and one
 * sketch insert, the closed minute windows within the retention, and the hourly rollups of older ones.
 */
export class UsageRecorder {
  current: UsageWindow;
  /** The closed minute windows, oldest first. */
  readonly closed: UsageWindow[] = [];
  /** The rollup windows, oldest first. */
  readonly rollups: UsageWindow[] = [];
  private overflowed = false;
  private readonly overflowKey: string;

  constructor(
    readonly settings: RecorderSettings,
    now: number,
  ) {
    this.current = { start: windowStart(now, settings.windowMs), resolution: "minute", series: new Map() };
    this.overflowKey = seriesKey(this.dimensionsOf(() => "other"));
  }

  /** The dimensions of the configured `by`, each with a value from `value`. */
  private dimensionsOf(value: (dimension: Dimension) => string, by: readonly Dimension[] = this.settings.by): Pick<Series, Dimension> {
    const dimensions: Pick<Series, Dimension> = {};
    for (const dimension of by) dimensions[dimension] = value(dimension);
    return dimensions;
  }

  /** Counts a completed request in the open window, under the given dimensions (default: the configured `by`). */
  record(observation: UsageObservation, by: readonly Dimension[] = this.settings.by): void {
    const dimensions = this.dimensionsOf((dimension) => valueOf(dimension, observation), by);
    const key = seriesKey(dimensions);
    const window = this.current.series;
    let series = window.get(key);
    if (!series) {
      if (window.size >= this.settings.maxSeries) {
        series = window.get(this.overflowKey);
        if (!series) {
          series = emptySeries(this.dimensionsOf(() => "other"));
          window.set(this.overflowKey, series);
        }
        if (!this.overflowed) {
          this.overflowed = true;
          this.settings.onOverflow(this.settings.maxSeries);
        }
      } else {
        series = emptySeries(dimensions);
        window.set(key, series);
      }
    }
    series.requests += 1;
    series.classes[Math.min(Math.max(Math.floor(observation.status / 100), 0), 5)]! += 1;
    if (observation.status >= 500) series.errors += 1;
    else if (observation.status >= 400) series.clientErrors += 1;
    series.sketch.add(observation.durationMs);
  }

  /**
   * Closes the open window once `now` passed its end, opening the window of `now`; merges closed windows older than the
   * retention into rollups and drops rollups older than theirs. Returns the windows it closed.
   */
  rotate(now: number): UsageWindow[] {
    const { windowMs, retentionMs, rollupMs, rollupRetentionMs } = this.settings;
    const closedNow: UsageWindow[] = [];
    if (now >= this.current.start + windowMs) {
      if (this.current.series.size > 0) {
        this.closed.push(this.current);
        closedNow.push(this.current);
      }
      this.current = { start: windowStart(now, windowMs), resolution: "minute", series: new Map() };
      this.overflowed = false;
    }
    while (this.closed.length > 0 && this.closed[0]!.start + windowMs <= now - retentionMs) {
      const old = this.closed.shift()!;
      const start = windowStart(old.start, rollupMs);
      let rollup = this.rollups.find((window) => window.start === start);
      if (!rollup) {
        rollup = { start, resolution: "hour", series: new Map() };
        this.rollups.push(rollup);
        this.rollups.sort((a, b) => a.start - b.start);
      }
      mergeWindowInto(rollup, old);
    }
    while (this.rollups.length > 0 && this.rollups[0]!.start + rollupMs <= now - rollupRetentionMs) this.rollups.shift();
    return closedNow;
  }

  /** Every window this worker keeps: rollups, closed windows and the open one. */
  windows(): UsageWindow[] {
    return [...this.rollups, ...this.closed, this.current];
  }
}

/** Adds every series of `source` to `target`, by key. */
export function mergeWindowInto(target: UsageWindow, source: UsageWindow): void {
  for (const [key, series] of source.series) {
    const existing = target.series.get(key);
    if (existing) mergeSeries(existing, series);
    else target.series.set(key, mergeSeries(emptySeries({ ...(series.route !== undefined ? { route: series.route } : {}), ...(series.tenant !== undefined ? { tenant: series.tenant } : {}), ...(series.user !== undefined ? { user: series.user } : {}) }), series));
  }
}

/** The size of a window of a resolution. */
export const windowSize = (window: UsageWindow, settings: Pick<RecorderSettings, "windowMs" | "rollupMs">) => (window.resolution === "hour" ? settings.rollupMs : settings.windowMs);
