import type { FileRecordFunctions, Http, JobLogger, QueueClient, Repositories, RunTenant } from "../public.ts";
import type { TriggerEvent, TriggerSourceRef } from "./source.ts";

/**
 * The triggers of the project, by name, with the data each one receives; the build fills it in `.generated/types.ts`
 * from the files of `triggers/`, so `emitTrigger` with an unknown name or wrong data is a type error.
 */
export interface TriggerNames {}

/** A trigger name of the project. */
export type TriggerName = Extract<keyof TriggerNames, string>;

/** The options of a trigger file. */
export interface TriggerOptions {
  /** How many events of this trigger run at once in one process (default 1). */
  concurrency?: number;
  /** The longest one event (or one batch) may run, like `30s` (default `30s`). */
  timeout?: string;
  /** How many times a failed event is retried before it is dead (default 3). */
  retries?: number;
  /** The delay before the first retry, doubled for each next one (default `10s`). */
  retryDelay?: string;
  /** Decides per event, before `handle`, whether it is handled; `false` discards it with the reason `when`. */
  when?: (event: TriggerEvent) => boolean | Promise<boolean>;
}

/** The options of a trigger with their defaults applied. */
export interface ResolvedTriggerOptions {
  concurrency: number;
  timeout: string;
  retries: number;
  retryDelay: string;
  when?: (event: TriggerEvent) => boolean | Promise<boolean>;
}

/** The option defaults of every trigger. */
export const TRIGGER_DEFAULTS: ResolvedTriggerOptions = { concurrency: 1, timeout: "30s", retries: 3, retryDelay: "10s" };

/** What a trigger's `handle` receives. */
export interface TriggerContext<Data = unknown> {
  /** The event being handled; in a batch trigger, the first event of the batch. */
  event: TriggerEvent<Data>;
  /** Every event of the batch, in a trigger with `batch: true`. */
  events?: TriggerEvent<Data>[];
  /** The trigger's name, like `uploads/new-image`. */
  trigger: string;
  /** The typed repositories. */
  repos: Repositories;
  /** Writes to the service logger with the trigger and the event id. */
  log: JobLogger;
  /** Aborted when the event runs out of time or the service shuts down. */
  signal: AbortSignal;
  /** The outgoing HTTP client, sending the event id as `x-request-id`; present while the `http` native is enabled. */
  http: Http;
  /** `createFile`, `openFile` and `fileUrl` for records of file entities. */
  files: FileRecordFunctions;
  /** Adds messages to the project's queues; present while the `queues` native is enabled. */
  queue?: QueueClient;
  /** The tenant the event runs for, when it has one. */
  tenant?: RunTenant;
  /** The event's delivery attempt, starting at 1. */
  attempt: number;
}

/** A trigger's handler. */
export type TriggerHandler<Data = unknown> = (ctx: TriggerContext<Data>) => unknown | Promise<unknown>;

/** What `trigger()` takes. */
export interface TriggerInput<Data = unknown> {
  /** The events the trigger reacts to: a reference made by a source factory, like `testSource()` or `cloudEvents({ type })`. */
  source: TriggerSourceRef;
  /** Runs once per event, or once per batch with `ctx.events` when `batch` is true. */
  handle: TriggerHandler<Data>;
  /** Hands the handler every event of one delivery at once (default false). */
  batch?: boolean;
  /**
   * Resolves the tenant of pushed requests like any route, so the handler runs for `ctx.tenant` (default false: push
   * routes are exempt from tenancy resolution).
   */
  tenant?: boolean;
  options?: TriggerOptions;
}

const TRIGGER_MARKER = Symbol.for("quickservicets.trigger");

/** A trigger declared with `trigger(...)`, the default export of each file in `triggers/`. */
export interface TriggerDefinition<Data = unknown> {
  readonly [TRIGGER_MARKER]: true;
  readonly source: TriggerSourceRef;
  readonly handle: TriggerHandler<Data>;
  readonly batch: boolean;
  /** Whether pushed requests resolve their tenant. */
  readonly tenant: boolean;
  /** The trigger's options with the defaults applied. */
  readonly options: ResolvedTriggerOptions;
}

/** The data type a trigger definition receives, for the generated `TriggerNames`. */
export type TriggerDataOf<T> = T extends TriggerDefinition<infer Data> ? Data : unknown;

/**
 * Declares a trigger: the events of `source` run `handle` with the repositories, like a job. The default export of
 * each file in `triggers/` must be one; the file's path without extension is the trigger's name.
 */
export function trigger<Data = unknown>(input: TriggerInput<Data>): TriggerDefinition<Data> {
  if (typeof input?.source?.kind !== "string" || input.source.kind === "") throw new Error("trigger() needs a source reference, like testSource()");
  if (typeof input.handle !== "function") throw new Error("trigger() needs a handle function");
  const options = { ...TRIGGER_DEFAULTS, ...definedOf(input.options ?? {}) };
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("trigger() options.concurrency must be an integer of at least 1");
  if (!Number.isInteger(options.retries) || options.retries < 0) throw new Error("trigger() options.retries must be an integer of at least 0");
  return { [TRIGGER_MARKER]: true, source: input.source, handle: input.handle, batch: input.batch === true, tenant: input.tenant === true, options };
}

/** The entries of an object whose value is defined. */
function definedOf<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** Whether a value is a definition made by `trigger()`. */
export function isTriggerDefinition(value: unknown): value is TriggerDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[TRIGGER_MARKER] === true;
}
