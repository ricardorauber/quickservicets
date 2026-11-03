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
  /** The sums of the usage counters features registered, by name; absent until one is added. */
  usage?: Record<string, number>;
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

/** The most routes, and methods per route, whose route value a recorder keeps; others are built on each request. */
const MAX_CACHED_ROUTES = 10_000;
const MAX_CACHED_METHODS = 32;

/** The bits of the dimensions a `by` list holds: 1 for route, 2 for tenant, 4 for user. */
const dimensionBits = (by: readonly Dimension[]) => (by.includes("route") ? 1 : 0) | (by.includes("tenant") ? 2 : 0) | (by.includes("user") ? 4 : 0);

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
  if (source.usage) {
    const usage = (target.usage ??= {});
    for (const [name, value] of Object.entries(source.usage)) usage[name] = (usage[name] ?? 0) + value;
  }
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
 * How one method and route is counted under one list of dimensions: its route value, and the series of the open window
 * it found last and by tenant and user. Made by `UsageRecorder.slot`; the recorder updates it.
 */
export interface RouteSlot {
  readonly by: readonly Dimension[];
  /** The dimensions of `by`: 1 for route, 2 for tenant, 4 for user. */
  readonly bits: number;
  /** The route value (`GET /posts`), or "" when `by` leaves the route out. */
  readonly route: string;
  /** The window the series below belong to. */
  window: UsageWindow | undefined;
  tenant: string;
  user: string;
  series: Series | undefined;
  index: Map<string, Map<string, Series>> | undefined;
}

/** Counts one request in a series. */
function count(series: Series, observation: UsageObservation): void {
  series.requests += 1;
  const status = observation.status;
  series.classes[status >= 500 ? 5 : status < 100 ? 0 : Math.floor(status / 100)]! += 1;
  if (status >= 500) series.errors += 1;
  else if (status >= 400) series.clientErrors += 1;
  series.sketch.add(observation.durationMs);
}

/** Keeps a series in an index by route, tenant and user value. */
function keep(index: Map<string, Map<string, Map<string, Series>>>, route: string, tenant: string, user: string, series: Series): void {
  let tenants = index.get(route);
  if (!tenants) index.set(route, (tenants = new Map()));
  let users = tenants.get(tenant);
  if (!users) tenants.set(tenant, (users = new Map()));
  users.set(user, series);
}

/**
 * The usage windows of one worker: the open window, recorded into with three map lookups, a few increments and one
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

  /** The route value (`GET /posts`) of each route and method, so a request builds no string. */
  private readonly routeValues = new Map<string | null, Map<string, string>>();
  /** The series of the open window by route, tenant and user value ("" for a dimension left out), as its keys hold them. */
  private index = new Map<string, Map<string, Map<string, Series>>>();
  /** The window `index` points into; another open window empties it. */
  private indexed: UsageWindow | undefined;
  /** The last `by` list recorded with, and the bits of its dimensions. */
  private lastBy: readonly Dimension[] | undefined;
  private lastBits = 0;

  /** The route value of a request's method and route, built once per method and route. */
  private routeValue(method: string, route: string | null): string {
    let methods = this.routeValues.get(route);
    if (!methods) {
      if (this.routeValues.size >= MAX_CACHED_ROUTES) return `${method} ${route ?? "unmatched"}`;
      this.routeValues.set(route, (methods = new Map()));
    }
    let value = methods.get(method);
    if (value === undefined) {
      value = `${method} ${route ?? "unmatched"}`;
      if (methods.size < MAX_CACHED_METHODS) methods.set(method, value);
    }
    return value;
  }

  /**
   * Counts a completed request in the open window, under the given dimensions (default: the configured `by`): three
   * map lookups on values the request already holds find its series, and no string or object is made unless the series
   * is new.
   */
  record(observation: UsageObservation, by: readonly Dimension[] = this.settings.by): void {
    if (by !== this.lastBy) {
      this.lastBy = by;
      this.lastBits = dimensionBits(by);
    }
    const bits = this.lastBits;
    const route = bits & 1 ? this.routeValue(observation.method, observation.route) : "";
    const tenant = bits & 2 ? (observation.tenantId ?? "-") : "";
    const user = bits & 4 ? (observation.userId ?? "-") : "";
    if (this.indexed !== this.current) {
      this.indexed = this.current;
      this.index = new Map();
    }
    let series = this.index.get(route)?.get(tenant)?.get(user);
    if (!series) {
      series = this.find(route, tenant, user, observation, by);
      if (series) keep(this.index, route, tenant, user, series);
      else series = this.overflowSeries();
    }
    count(series, observation);
  }

  /**
   * The slot of a method and route under a list of dimensions (default: the configured `by`), for callers that decide
   * once per route how its requests are counted and then record with `recordIn`.
   */
  slot(method: string, route: string | null, by: readonly Dimension[] = this.settings.by): RouteSlot {
    const bits = dimensionBits(by);
    return { by, bits, route: bits & 1 ? `${method} ${route ?? "unmatched"}` : "", window: undefined, tenant: "", user: "", series: undefined, index: undefined };
  }

  /**
   * Counts a completed request of a slot's method and route in the open window, as `record` does with the slot's
   * dimensions: a request with the tenant and user of the slot's last one finds its series without a lookup, others
   * with two.
   */
  recordIn(slot: RouteSlot, observation: UsageObservation): void {
    const tenant = slot.bits & 2 ? (observation.tenantId ?? "-") : "";
    const user = slot.bits & 4 ? (observation.userId ?? "-") : "";
    let series: Series | undefined;
    if (slot.window !== this.current) {
      slot.window = this.current;
      slot.series = undefined;
      slot.index = undefined;
    } else if (slot.series !== undefined && slot.tenant === tenant && slot.user === user) series = slot.series;
    if (!series) {
      series = slot.index?.get(tenant)?.get(user);
      if (!series) {
        series = this.find(slot.route, tenant, user, observation, slot.by);
        if (series) {
          slot.index ??= new Map();
          let users = slot.index.get(tenant);
          if (!users) slot.index.set(tenant, (users = new Map()));
          users.set(user, series);
        } else series = this.overflowSeries();
      }
      // One series per slot is remembered, the overflow one too, so the memory stays bounded.
      slot.tenant = tenant;
      slot.user = user;
      slot.series = series;
    }
    count(series, observation);
  }

  /**
   * The series of the open window with these dimension values, found by its key or made; undefined when it is new and
   * the window already holds `maxSeries`.
   */
  private find(route: string, tenant: string, user: string, observation: UsageObservation, by: readonly Dimension[]): Series | undefined {
    const key = `${route}\n${tenant}\n${user}`;
    const window = this.current.series;
    let series = window.get(key);
    if (!series) {
      if (window.size >= this.settings.maxSeries) return undefined;
      series = emptySeries(this.dimensionsOf((dimension) => valueOf(dimension, observation), by));
      window.set(key, series);
    }
    return series;
  }

  /**
   * Adds a usage value to the open window's series of these dimension values (`-` for a missing one), keyed like
   * request series under the configured `by`; past `maxSeries` it goes to the `other` series.
   */
  addUsage(name: string, value: number, values: { route?: string; tenant?: string; user?: string }): void {
    const by = this.settings.by;
    const route = by.includes("route") ? (values.route ?? "-") : "";
    const tenant = by.includes("tenant") ? (values.tenant ?? "-") : "";
    const user = by.includes("user") ? (values.user ?? "-") : "";
    const key = `${route}\n${tenant}\n${user}`;
    const window = this.current.series;
    let series = window.get(key);
    if (!series) {
      if (window.size >= this.settings.maxSeries) series = this.overflowSeries();
      else {
        series = emptySeries(this.dimensionsOf((dimension) => (dimension === "route" ? route : dimension === "tenant" ? tenant : user)));
        window.set(key, series);
      }
    }
    const usage = (series.usage ??= {});
    usage[name] = (usage[name] ?? 0) + value;
  }

  /** The series whose dimensions are all `other`, counting the series past `maxSeries`; the overflow is logged once per window. */
  private overflowSeries(): Series {
    const window = this.current.series;
    let overflow = window.get(this.overflowKey);
    if (!overflow) {
      overflow = emptySeries(this.dimensionsOf(() => "other"));
      window.set(this.overflowKey, overflow);
    }
    if (!this.overflowed) {
      this.overflowed = true;
      this.settings.onOverflow(this.settings.maxSeries);
    }
    return overflow;
  }

  /**
   * Closes the open window once `now` passed its end, opening the window of `now`; merges closed windows older than the
   * retention into rollups and drops rollups older than theirs. Returns the windows it closed and the rollups it changed.
   */
  rotate(now: number): { closed: UsageWindow[]; rolled: UsageWindow[] } {
    const { windowMs, retentionMs, rollupMs, rollupRetentionMs } = this.settings;
    const closedNow: UsageWindow[] = [];
    const rolled = new Set<UsageWindow>();
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
      rolled.add(rollup);
    }
    while (this.rollups.length > 0 && this.rollups[0]!.start + rollupMs <= now - rollupRetentionMs) rolled.delete(this.rollups.shift()!);
    return { closed: closedNow, rolled: [...rolled] };
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
