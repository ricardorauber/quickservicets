import { parseDuration, safeLog, type JobClock, type JobLogFields, type JobLogger, type Logger } from "../public.ts";
import type { TriggerCheckpoints } from "./checkpoints.ts";
import type { TriggerEvent, TriggerOutcome, TriggerSource } from "./source.ts";
import type { TriggerDefinition } from "./trigger.ts";

/** What `emit` of a poll takes besides the events: called with each event's outcome once it is handled. */
export interface PollAcknowledgments {
  /** Called for an event that completed or was discarded, so the source deletes or commits it. */
  ack?(outcome: TriggerOutcome): unknown | Promise<unknown>;
  /**
   * Called for an event that failed with attempts left, so the source delivers it again after `retryInMs` (like a
   * visibility timeout); the next delivery carries the next `attempt`.
   */
  nack?(outcome: TriggerOutcome, retry: { retryInMs: number }): unknown | Promise<unknown>;
  /** Moves an event that failed its last attempt to the source's dead letters; without it the event is acknowledged. */
  deadLetter?(outcome: TriggerOutcome): unknown | Promise<unknown>;
}

/** What a source's `poll(ref, ctx)` receives. */
export interface TriggerPollContext {
  /**
   * Runs the trigger on the events with its `concurrency` and resolves their outcomes once every one was handled, so a
   * poll that awaits it never pulls faster than the trigger handles; calls `ack` or `nack` per event.
   */
  emit(events: readonly TriggerEvent[], acknowledgments?: PollAcknowledgments): Promise<TriggerOutcome[]>;
  /** Aborted at shutdown: the poll stops pulling and returns. */
  signal: AbortSignal;
  /** The service logger, adding the trigger. */
  log: JobLogger;
  /** The partition leases and positions of the trigger, for sources that read partitions (streams). */
  checkpoints: TriggerCheckpoints;
}

/** What starting a poller needs. */
export interface PollerInput {
  name: string;
  definition: TriggerDefinition;
  source: TriggerSource;
  /** Runs the trigger on events. */
  run(events: readonly TriggerEvent[]): Promise<TriggerOutcome[]>;
  /** Called for an event that failed its last attempt, after it was dead-lettered or acknowledged. */
  onDead?(outcome: TriggerOutcome, event: TriggerEvent): void | Promise<void>;
  /** The random numbers of the retry jitter (default `Math.random`). */
  random?: () => number;
  checkpoints(): TriggerCheckpoints;
  logger: Logger;
  clock: JobClock;
  /** The restart delays after a failed poll, in milliseconds. */
  backoff: { min: number; max: number };
}

/** A running poll of one trigger. */
export interface Poller {
  /** Aborts the poll's signal and cancels a pending restart. */
  stop(): void;
  /** Resolves once the handlers running now finished, or after `graceMs`. */
  drain(graceMs: number): Promise<void>;
}

/** The longest delay before a retry of a polled event. */
export const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * The delay before retrying a polled event after its failed `attempt`: `retryDelay × 2^(attempt − 1)`, at most 1 hour,
 * with ±10% jitter.
 */
export function retryDelayMs(retryDelay: string, attempt: number, random: () => number = Math.random): number {
  const base = Math.min((parseDuration(retryDelay) ?? 10_000) * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
  return Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * 0.1)));
}

/**
 * Starts a source's `poll(ref, ctx)` for one trigger and keeps it running: when it throws or rejects, it logs
 * `trigger.poll.failed` and starts it again after a delay doubling from `backoff.min` to `backoff.max`, back to the
 * minimum after a successful emission; when it returns before shutdown, it starts again after `backoff.min`. Timers
 * and awaits only, never a busy loop.
 */
export function startPoller(input: PollerInput): Poller {
  const controller = new AbortController();
  const running = new Set<Promise<unknown>>();
  let delay = input.backoff.min;
  let timer: unknown;
  const write = (level: "info" | "warn" | "error") => (line: string, fields?: JobLogFields) => safeLog(input.logger, level, { timestamp: new Date(input.clock.now()).toISOString(), message: String(line), ...fields, trigger: input.name });
  const context: TriggerPollContext = {
    async emit(events, acknowledgments = {}) {
      const work = (async () => {
        const outcomes = await input.run(events);
        const byId = new Map(events.map((event) => [event.id, event]));
        for (const outcome of outcomes) {
          if (outcome.status !== "failed") {
            await acknowledgments.ack?.(outcome);
            continue;
          }
          const event = byId.get(outcome.eventId);
          const attempt = event?.attempt ?? 1;
          // A failed event is retried up to the trigger's retries, then dead-lettered (or acknowledged) and reported.
          if (attempt <= input.definition.options.retries) {
            await acknowledgments.nack?.(outcome, { retryInMs: retryDelayMs(input.definition.options.retryDelay, attempt, input.random) });
            continue;
          }
          if (acknowledgments.deadLetter) await acknowledgments.deadLetter(outcome);
          else await acknowledgments.ack?.(outcome);
          if (event) await input.onDead?.(outcome, event);
        }
        // A successful emission resets the restart delay.
        delay = input.backoff.min;
        return outcomes;
      })();
      running.add(work);
      try {
        return await work;
      } finally {
        running.delete(work);
      }
    },
    signal: controller.signal,
    log: { info: write("info"), warn: write("warn"), error: write("error") },
    get checkpoints() {
      return input.checkpoints();
    },
  };
  const schedule = (ms: number) => {
    if (controller.signal.aborted) return;
    timer = input.clock.setTimeout(() => {
      timer = undefined;
      void once();
    }, ms);
  };
  const once = async () => {
    if (controller.signal.aborted) return;
    try {
      await input.source.poll!(input.definition.source as never, context);
      schedule(input.backoff.min);
    } catch (error) {
      if (controller.signal.aborted) return;
      safeLog(input.logger, "error", { timestamp: new Date(input.clock.now()).toISOString(), message: "trigger.poll.failed", trigger: input.name, kind: input.source.kind, retryInMs: delay, error: { message: (error as Error)?.message ?? String(error) } });
      const wait = delay;
      delay = Math.min(delay * 2, input.backoff.max);
      schedule(wait);
    }
  };
  void once();
  return {
    stop() {
      controller.abort();
      if (timer !== undefined) input.clock.clearTimeout(timer);
      timer = undefined;
    },
    async drain(graceMs) {
      if (running.size === 0) return;
      let limit: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...running]), new Promise<void>((resolve) => (limit = setTimeout(resolve, graceMs)))]);
      clearTimeout(limit);
    },
  };
}
