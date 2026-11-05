import { runAfterHooks, contextHttp, DEADLINE_MARGIN_MS, fileRecords, parseDuration, queues, resolveRunRepositories, safeLog, withJobOperation, type JobLogFields, type JobLogger, type Logger, type Repositories, type RunTenant } from "../public.ts";
import type { TriggerEvent, TriggerOutcome } from "./source.ts";
import type { TriggerContext, TriggerDefinition } from "./trigger.ts";
import { isTriggerDiscard } from "./discard.ts";

/** What running a trigger's events needs. */
export interface TriggerRunInput {
  /** The trigger's name, like `uploads/new-image`. */
  name: string;
  definition: TriggerDefinition;
  /** The events to handle, in order. */
  events: readonly TriggerEvent[];
  /** The repositories of the running service. */
  repos: () => Repositories;
  logger: Logger;
  /** Whether the `queues` native runs, so handlers get `ctx.queue`. */
  queues?: boolean;
  /** Aborts every handler, like a shutdown. */
  signal?: AbortSignal;
  /** The platform's deadline (epoch milliseconds): each handler stops 500 ms before it, when that comes first. */
  deadline?: number;
  /**
   * Whether the events come in order (stream partitions, FIFO queues): the events of each partition
   * (`attributes.partition`) are handled one after the other, and the first failure fails every later event of its
   * partition without running it.
   */
  ordered?: boolean;
  /** The tenant the events run for, like the one a pushed request resolved. */
  tenant?: RunTenant;
  /** The hooks around each event: before the handler, after its outcome, and after a failure. */
  hooks?: TriggerRunHooks;
  /** Whether a failed event was its last attempt (default: its attempt is past the trigger's retries). */
  isFinal?: (event: TriggerEvent) => boolean;
}

/** What `beforeHandle` receives. */
export interface BeforeHandle {
  trigger: string;
  event: TriggerEvent;
}

/** What `afterHandle` receives. */
export interface AfterHandle {
  trigger: string;
  event: TriggerEvent;
  status: TriggerOutcome["status"];
  durationMs: number;
}

/** What `onFailed` receives: `final` is true on the event's last attempt. */
export interface TriggerFailed {
  trigger: string;
  event: TriggerEvent;
  error: unknown;
  final: boolean;
}

/** The hooks a run calls, each a list of functions. */
export interface TriggerRunHooks {
  /** Each may return a changed event, or `null` to discard it; a throw fails the event. */
  beforeHandle?: readonly ((step: BeforeHandle, ctx: undefined) => TriggerEvent | null | undefined | void | Promise<TriggerEvent | null | undefined | void>)[];
  afterHandle?: readonly ((done: AfterHandle, ctx: undefined) => unknown)[];
  onFailed?: readonly ((failure: TriggerFailed, ctx: undefined) => unknown)[];
}

/** The partition of an event in an ordered batch: its `partition` attribute, or one partition for all. */
export const partitionOf = (event: TriggerEvent): string => event.attributes.partition ?? "";

/** The error of an event left unhandled because an earlier event of its ordered partition failed. */
export const skippedAfterFailure = (eventId: string) => new Error(`Not handled: the earlier event ${eventId} of its partition failed`);

/** The error of a handler that ran out of time. */
export const triggerTimedOut = (name: string, ms: number) => new Error(`Trigger ${name} timed out after ${ms} ms`);

/** A logger writing the trigger and the event id with every entry. */
function eventLogger(logger: Logger, name: string, eventId: string): JobLogger {
  const write = (level: "info" | "warn" | "error") => (line: string, fields?: JobLogFields) =>
    safeLog(logger, level, { timestamp: new Date().toISOString(), message: String(line), ...fields, trigger: name, eventId });
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/**
 * Runs `fn` with a signal aborted after `ms` or when `outer` aborts, rejecting with the timeout error at the limit even
 * when `fn` ignores the signal.
 */
async function withLimit<T>(ms: number, outer: AbortSignal | undefined, onTimeout: () => Error, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = onTimeout();
      controller.abort(error);
      reject(error);
    }, Math.max(0, ms));
  });
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  try {
    return await Promise.race([fn(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}

/** Runs one call of the handler, for one event or a batch, inside the trigger's operation; resolves the error or undefined. */
async function runHandler(input: TriggerRunInput, events: readonly TriggerEvent[]): Promise<unknown> {
  const { name, definition } = input;
  const first = events[0]!;
  const timeout = parseDuration(definition.options.timeout) ?? 30_000;
  // The smaller of the trigger's timeout and the time left before the platform's deadline, less a margin.
  const limit = input.deadline === undefined ? timeout : Math.max(0, Math.min(timeout, input.deadline - Date.now() - DEADLINE_MARGIN_MS));
  const run = { job: { name: `trigger/${name}`, runId: first.id } };
  try {
    await withLimit(limit, input.signal, () => triggerTimedOut(name, limit), async (signal) => {
      const http = contextHttp(first.id);
      const context = {
        event: first,
        ...(definition.batch ? { events: [...events] } : {}),
        trigger: name,
        repos: resolveRunRepositories(run, input.repos as never) as unknown as Repositories,
        log: eventLogger(input.logger, name, first.id),
        signal,
        files: fileRecords,
        ...(http ? { http } : {}),
        ...(input.queues ? { queue: queues } : {}),
        ...(input.tenant ? { tenant: input.tenant } : {}),
        attempt: first.attempt,
      } as TriggerContext;
      // Writes carry the actor `job:trigger/<name>`, like a job run's.
      await withJobOperation(run.job, () => definition.handle(context));
    });
    return undefined;
  } catch (error) {
    return error ?? new Error(`Trigger ${name} failed`);
  }
}

/** Runs `work` over `items` with at most `limit` at once, keeping the order of the results. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return results;
}

/**
 * Handles events with a trigger: once per event with the trigger's `concurrency`, or once for all of them with
 * `batch: true`; each call is limited by the trigger's `timeout`. Resolves one outcome per event, in order.
 */
export async function runTriggerEvents(input: TriggerRunInput): Promise<TriggerOutcome[]> {
  const { name, definition, events } = input;
  if (events.length === 0) return [];
  const entry = (event: TriggerEvent) => ({ timestamp: new Date().toISOString(), trigger: name, kind: event.kind, eventId: event.id, attempt: event.attempt });
  const outcomeOf = (event: TriggerEvent, error: unknown): TriggerOutcome => {
    if (error === undefined) return { eventId: event.id, trigger: name, status: "completed" };
    // A TriggerDiscard drops the event without a retry; any other error fails it.
    if (isTriggerDiscard(error)) return { eventId: event.id, trigger: name, status: "discarded", reason: error.reason };
    return { eventId: event.id, trigger: name, status: "failed", error };
  };
  const logOutcome = (event: TriggerEvent, outcome: TriggerOutcome, durationMs?: number) => {
    const details = outcome.status === "failed" ? { error: { message: (outcome.error as Error)?.message ?? String(outcome.error) } } : outcome.status === "discarded" ? { reason: outcome.reason } : {};
    safeLog(input.logger, outcome.status === "failed" ? "warn" : "info", { ...entry(event), message: `trigger.event.${outcome.status}`, ...(durationMs !== undefined ? { durationMs } : {}), ...details });
  };
  /**
   * The event to hand the handler after the `when` filter and the `beforeHandle` hooks, or the outcome that ends it
   * first: discarded with the reason `when` or `beforeHandle`, or failed when a hook throws.
   */
  const prepared = async (event: TriggerEvent): Promise<{ event: TriggerEvent } | { outcome: TriggerOutcome }> => {
    try {
      if (definition.options.when && (await definition.options.when(event)) === false) return { outcome: { eventId: event.id, trigger: name, status: "discarded", reason: "when" } };
      let current = event;
      for (const hook of input.hooks?.beforeHandle ?? []) {
        const result = await hook({ trigger: name, event: current }, undefined);
        if (result === null) return { outcome: { eventId: event.id, trigger: name, status: "discarded", reason: "beforeHandle" } };
        if (result !== undefined) current = result as TriggerEvent;
      }
      return { event: current };
    } catch (error) {
      return { outcome: outcomeOf(event, error) };
    }
  };
  const isFinal = input.isFinal ?? ((event: TriggerEvent) => event.attempt > definition.options.retries);
  const finished = async (event: TriggerEvent, outcome: TriggerOutcome, durationMs: number) => {
    logOutcome(event, outcome, durationMs);
    if (input.hooks?.afterHandle?.length) await runAfterHooks(input.hooks.afterHandle as never, { trigger: name, event, status: outcome.status, durationMs }, undefined);
    if (outcome.status === "failed" && input.hooks?.onFailed?.length) await runAfterHooks(input.hooks.onFailed as never, { trigger: name, event, error: outcome.error, final: isFinal(event) }, undefined);
    return outcome;
  };
  const handled = async (batch: readonly TriggerEvent[]): Promise<TriggerOutcome[]> => {
    for (const event of batch) safeLog(input.logger, "info", { ...entry(event), message: "trigger.event.started" });
    const started = performance.now();
    const ready: TriggerEvent[] = [];
    const ended = new Map<string, TriggerOutcome>();
    for (const event of batch) {
      const step = await prepared(event);
      if ("event" in step) ready.push(step.event);
      else ended.set(event.id, step.outcome);
    }
    const error = ready.length > 0 ? await runHandler(input, ready) : undefined;
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    const handledEvents = new Map(ready.map((event) => [event.id, event]));
    const outcomes: TriggerOutcome[] = [];
    for (const event of batch) outcomes.push(await finished(handledEvents.get(event.id) ?? event, ended.get(event.id) ?? outcomeOf(event, error), durationMs));
    return outcomes;
  };
  if (definition.batch) return handled(events);
  if (!input.ordered) return (await pooled(events, definition.options.concurrency, (event) => handled([event]))).flat();
  // Ordered: partitions run side by side with the trigger's concurrency, the events of one partition in order.
  const partitions = new Map<string, TriggerEvent[]>();
  for (const event of events) partitions.set(partitionOf(event), [...(partitions.get(partitionOf(event)) ?? []), event]);
  const byPartition = await pooled([...partitions.values()], definition.options.concurrency, async (list) => {
    const outcomes: TriggerOutcome[] = [];
    let failed: string | undefined;
    for (const event of list) {
      if (failed !== undefined) {
        outcomes.push(await finished(event, { eventId: event.id, trigger: name, status: "failed", error: skippedAfterFailure(failed) }, 0));
        continue;
      }
      const [outcome] = await handled([event]);
      if (outcome!.status === "failed") failed = event.id;
      outcomes.push(outcome!);
    }
    return outcomes;
  });
  // Back in the order of the events.
  const found = new Map(byPartition.flat().map((outcome) => [outcome.eventId, outcome]));
  return events.map((event) => found.get(event.id)!);
}
