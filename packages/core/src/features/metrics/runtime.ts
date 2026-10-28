import { safeLog, type JobClock, type Logger } from "../public.ts";
import { queryWindows, rangeOf, type MetricsQuery, type MetricsResult } from "./query.ts";
import { storedWindow, usageWindow, type MetricsStore } from "./store.ts";
import { emptySeries, mergeSeries, UsageRecorder, type RecorderSettings, type Series, type UsageObservation, type UsageWindow } from "./windows.ts";

/** The most closed windows a worker keeps while its store fails. */
export const MAX_UNFLUSHED = 10;
/** How often a failing flush may log `metrics.flush.failed`. */
const FAILURE_LOG_MS = 60_000;

/** What the runtime of one worker needs. */
export interface MetricsRuntimeOptions {
  settings: RecorderSettings;
  clock: JobClock;
  logger: Logger;
  /** Where closed windows go so every worker reads them; without one, they stay in this worker's memory. */
  store?: MetricsStore;
  /** `<hostname>:<pid>:<worker index>`, the instance of the rows this worker writes. */
  instance: string;
  /**
   * Rolls minute windows into hours in this worker and writes the rollups to the store too, for stores that keep what
   * they receive (a project's store); the database store rolls up with its job instead.
   */
  rollupLocally?: boolean;
  /** Called with each closed window of this worker. */
  onWindowClosed?: (window: UsageWindow) => void;
}

/**
 * The usage metrics of one worker: the recorder, the closed windows not yet in the store, flushing on each window
 * boundary, and queries merging the stored windows with this worker's own.
 */
export class MetricsRuntime {
  readonly recorder: UsageRecorder;
  /** Closed windows the store has not accepted yet, oldest first. */
  readonly unflushed: UsageWindow[] = [];
  private lastFailureLog = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  private flushing: Promise<void> | undefined;
  /** Every closed window of this worker since it started, merged by series, for counters that never reset. */
  private readonly cumulative = new Map<string, Series>();

  constructor(readonly options: MetricsRuntimeOptions) {
    this.recorder = new UsageRecorder(options.settings, options.clock.now());
  }

  record(observation: UsageObservation, by?: RecorderSettings["by"]): void {
    this.recorder.record(observation, by);
  }

  /** Closes the window when its boundary passed; with a store, hands the closed windows to it. */
  rotate(): Promise<void> {
    const { closed, rolled } = this.recorder.rotate(this.options.clock.now());
    for (const window of closed) this.options.onWindowClosed?.(window);
    for (const window of closed) {
      for (const [key, series] of window.series) {
        let target = this.cumulative.get(key);
        if (!target) this.cumulative.set(key, (target = emptySeries({ ...(series.route !== undefined ? { route: series.route } : {}), ...(series.tenant !== undefined ? { tenant: series.tenant } : {}), ...(series.user !== undefined ? { user: series.user } : {}) })));
        mergeSeries(target, series);
      }
    }
    if (!this.options.store) return Promise.resolve();
    // The store keeps closed windows, rollups and their retention; the worker keeps only what it has not written, and
    // the windows it rolls up itself when the store does not.
    if (!this.options.rollupLocally) {
      this.recorder.closed.length = 0;
      this.recorder.rollups.length = 0;
    }
    this.unflushed.push(...closed);
    if (this.options.rollupLocally) for (const window of rolled) if (!this.unflushed.includes(window)) this.unflushed.push(window);
    if (this.unflushed.length > MAX_UNFLUSHED) this.dropped += this.unflushed.splice(0, this.unflushed.length - MAX_UNFLUSHED).length;
    return this.flush();
  }

  /** Writes the unflushed windows to the store; a failure keeps them for the next boundary. */
  flush(): Promise<void> {
    const store = this.options.store;
    if (!store || this.unflushed.length === 0) {
      this.logDropped();
      return Promise.resolve();
    }
    this.flushing ??= (async () => {
      const batch = [...this.unflushed];
      try {
        await store.write(batch.map((window) => storedWindow(window, this.options.instance)));
        this.unflushed.splice(0, batch.length);
      } catch (error) {
        this.failed(error);
      } finally {
        this.flushing = undefined;
        this.logDropped();
      }
    })();
    return this.flushing;
  }

  private failed(error: unknown): void {
    this.lastError = (error as Error)?.message ?? String(error);
  }

  private lastError: string | undefined;

  /** Logs the windows dropped since the last entry, at most once per minute. */
  private logDropped(): void {
    if (this.dropped === 0) return;
    const now = this.options.clock.now();
    if (now - this.lastFailureLog < FAILURE_LOG_MS) return;
    this.lastFailureLog = now;
    safeLog(this.options.logger, "error", {
      timestamp: new Date(now).toISOString(),
      message: "metrics.flush.failed",
      dropped: this.dropped,
      ...(this.lastError ? { error: { message: this.lastError } } : {}),
    });
    this.dropped = 0;
  }

  /** Every series of this worker since it started, its closed windows with the open one, never reset by retention. */
  sinceStart(): Series[] {
    const merged = new Map<string, Series>();
    for (const source of [this.cumulative, this.recorder.current.series]) {
      for (const [key, series] of source) {
        let target = merged.get(key);
        if (!target) merged.set(key, (target = emptySeries({ ...(series.route !== undefined ? { route: series.route } : {}), ...(series.tenant !== undefined ? { tenant: series.tenant } : {}), ...(series.user !== undefined ? { user: series.user } : {}) })));
        mergeSeries(target, series);
      }
    }
    return [...merged.values()];
  }

  /** The series of a range: the stored windows of every worker and replica, with this worker's own unflushed ones. */
  async query(query: MetricsQuery = {}): Promise<MetricsResult> {
    const now = this.options.clock.now();
    const { settings, store } = this.options;
    const local = this.recorder.windows();
    if (!store) return queryWindows(local, settings, query, now);
    const { from, to } = rangeOf(query, now);
    // Rollup windows start up to one rollup before the range and still overlap it.
    let stored = (await store.read({ from: new Date(from - settings.rollupMs), to: new Date(to + 1) })).map(usageWindow);
    // A store that keeps the worker's rollups also keeps the minute windows they came from until they are pruned.
    if (this.options.rollupLocally) stored = stored.filter((window) => window.resolution === "hour" || window.start + settings.windowMs > now - settings.retentionMs);
    const own = this.options.rollupLocally ? [this.recorder.current] : local;
    return queryWindows([...stored, ...this.unflushed, ...own], settings, query, now);
  }
}
