import {
  tenantRuns,
  runForTenant,
  currentDatabaseScope,
  afterCommit,
  reportFailure,
  currentOperation,
  inTransaction,
  jsonLogger,
  runAfterHooks,
  safeLog,
  activeSpan,
  startSpan,
  tracingEnabled,
  withSpan,
  type SpanContext,
  type AnyEvent,
  type CustomEvent,
  type EventActor,
  type EventFor,
  type FeatureHook,
  type Logger,
  type OperationInfo,
  type PayloadOf,
  type WriteChange,
  type WriteEvent,
} from "../public.ts";
import * as patterns from "./patterns.ts";
import { eventTraces } from "./traces.ts";
import { addOutboxPatterns, inOutboxTransaction, insertOutboxRow, outboxRunning, storesType } from "./outbox.ts";
import { registerConsumer, type ConsumerOptions } from "./delivery.ts";
import { sharedState } from "./state.ts";

/** When a listener runs: inside the write's transaction (awaited, may veto it) or after the commit (the default). */
export type ListenerPhase = "afterCommit" | "inTransaction";

export interface ListenOptions {
  phase?: ListenerPhase;
}

export type EventListener<E = AnyEvent> = (event: E) => void | Promise<void>;

/**
 * Carries events to after-commit listeners. The default is the in-process `memoryEventBus()`; a project may set its
 * own (`events: { bus }`) to fan events out across processes, while in-transaction listeners and the outbox stay in
 * the native.
 */
export interface EventBus {
  /** Hands over a committed event, once. */
  publish(event: AnyEvent): void | Promise<void>;
  /** Registers an after-commit listener for a pattern; may return a function that removes it. */
  subscribe(pattern: string, listener: EventListener): void | (() => void);
}

/** The in-process bus, with what the native needs to wait for its deliveries. */
export interface MemoryEventBus extends EventBus {
  /** Resolves once every delivery started so far has finished. */
  idle(): Promise<void>;
  /** The deliveries not finished yet. */
  pending(): number;
  /** Whether any listener matches a type. */
  hasListeners(type: string): boolean;
  /** Removes every listener. */
  clear(): void;
}

interface Registration {
  pattern: patterns.CompiledPattern;
  listener: EventListener;
  /** Deliveries of this listener chain one after the other, in commit order. */
  tail: Promise<void>;
  active: boolean;
}

/** Finds the registrations matching a type once, then keeps them until the registrations change. */
function lookup(registrations: Registration[]) {
  let byType = new Map<string, Registration[]>();
  return {
    of(type: string): Registration[] {
      let found = byType.get(type);
      if (!found) {
        found = registrations.filter((registration) => patterns.patternMatches(registration.pattern, type));
        byType.set(type, found);
      }
      return found;
    },
    reset() {
      byType = new Map();
    },
  };
}

const shared = sharedState("bus", () => ({
  logger: jsonLogger as Logger,
  enabled: false,
  /** The listeners that run inside the write's transaction. */
  inTransaction: [] as Registration[],
  inTransactionLookup: undefined as ReturnType<typeof lookup> | undefined,
  /** The bus after-commit listeners subscribe to, and the in-process one used by default. */
  bus: undefined as EventBus | undefined,
  memory: undefined as MemoryEventBus | undefined,
  /** Removes the after-commit listeners subscribed to a custom bus when the native stops. */
  unsubscribes: [] as (() => void)[],
  beforeEmit: [] as readonly FeatureHook<AnyEvent | null, { operation: OperationInfo | undefined }>[],
  afterEmit: [] as readonly FeatureHook<AnyEvent, undefined>[],
}));
shared.inTransactionLookup ??= lookup(shared.inTransaction);

/** Creates an in-process bus: each listener gets its events one at a time, and a failing one is logged and kept. */
export function memoryEventBus(): MemoryEventBus {
  const registrations: Registration[] = [];
  const found = lookup(registrations);
  const pending = new Set<Promise<void>>();
  return {
    publish(event) {
      for (const registration of found.of(event.type)) {
        const delivery = registration.tail.then(async () => {
          if (!registration.active) return;
          try {
            await registration.listener(event);
          } catch (error) {
            safeLog(shared.logger, "error", {
              timestamp: new Date().toISOString(),
              message: "event.listener.failed",
              type: event.type,
              eventId: event.id,
              error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) },
            });
            reportFailure(error, {
              kind: "event",
              tags: { event: event.type },
              ...(event.actor.user !== undefined ? { user: { id: event.actor.user } } : {}),
              ...(event.actor.tenant !== undefined ? { tenant: { id: event.actor.tenant } } : {}),
              ...(event.requestId ? { requestId: event.requestId } : {}),
            });
          }
        });
        registration.tail = delivery;
        pending.add(delivery);
        void delivery.finally(() => pending.delete(delivery));
      }
    },
    subscribe(pattern, listener) {
      const registration: Registration = { pattern: patterns.compilePattern(pattern), listener, tail: Promise.resolve(), active: true };
      registrations.push(registration);
      found.reset();
      return () => {
        registration.active = false;
        const at = registrations.indexOf(registration);
        if (at >= 0) registrations.splice(at, 1);
        found.reset();
      };
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    pending: () => pending.size,
    hasListeners: (type) => found.of(type).length > 0,
    clear() {
      for (const registration of registrations) registration.active = false;
      registrations.length = 0;
      found.reset();
    },
  };
}
shared.memory ??= memoryEventBus();

const enabledCheck = () => {
  if (!shared.enabled) throw new Error("events is not enabled; add events: {} to quickservicets.config.ts");
};

/** The bus of the `events` feature: write events and custom events, delivered to listeners by pattern. */
export interface Events {
  /**
   * Registers a listener for a pattern and returns a function that removes it: an exact type, `*` segments matching one
   * segment each (`user.*`, `*.created`), `*` for every event, or `<entity>.written` for an entity's created, updated
   * and deleted events. `afterCommit` listeners (the default) get each event after the outermost commit, never for a
   * rolled-back write; `inTransaction` listeners run inside the write's transaction, and a throw rolls it back.
   */
  on<P extends string>(pattern: P, listener: EventListener<EventFor<P>>, options?: ListenOptions): () => void;
  /**
   * Publishes a custom event, typed by `EventMap`, and resolves with its id: inside a transaction, `inTransaction`
   * listeners get it at once and after-commit listeners after the commit (never after a rollback); outside one,
   * every listener gets it at once.
   */
  emit<K extends string>(type: K, payload: PayloadOf<K>): Promise<string>;
  /**
   * Registers a durable consumer, from setup: every stored event matching `pattern` gets a delivery row in its write's
   * transaction, delivered at least once by the dispatchers of every worker, with retries and backoff. Needs
   * `events: { outbox: true }`.
   */
  deliver(name: string, options: ConsumerOptions): void;
  /** Resolves once every after-commit delivery of the in-process bus started so far has finished. */
  idle(): Promise<void>;
}

export const events: Events = {
  on(pattern, listener, options = {}) {
    enabledCheck();
    const compiled = patterns.compilePattern(pattern);
    if ((options.phase ?? "afterCommit") === "inTransaction") {
      const registration: Registration = { pattern: compiled, listener: listener as EventListener, tail: Promise.resolve(), active: true };
      shared.inTransaction.push(registration);
      shared.inTransactionLookup!.reset();
      return () => {
        const at = shared.inTransaction.indexOf(registration);
        if (at >= 0) shared.inTransaction.splice(at, 1);
        shared.inTransactionLookup!.reset();
      };
    }
    const tenantListener: EventListener = (event) => (tracingEnabled() ? tracedListener(event, () => inEventTenant(event, () => (listener as EventListener)(event))) : inEventTenant(event, () => (listener as EventListener)(event)));
    const unsubscribe = shared.bus!.subscribe(pattern, tenantListener) ?? (() => {});
    shared.unsubscribes.push(unsubscribe);
    return unsubscribe;
  },
  async emit(type, payload) {
    enabledCheck();
    patterns.assertCustomType(type);
    const event: CustomEvent = { id: Bun.randomUUIDv7(), type, payload, ...operationFields(), at: new Date() };
    keepTrace(event);
    await publish(event, true);
    return event.id;
  },
  deliver(name, options) {
    enabledCheck();
    if (!outboxRunning()) throw new Error(`${name} needs events: { outbox: true }`);
    addOutboxPatterns(registerConsumer(name, options));
  },
  idle: () => shared.memory!.idle(),
};

/** The number of after-commit deliveries of the in-process bus not finished yet. */
export const pendingDeliveries = () => shared.memory!.pending();

/** Starts the bus for a running service: its logger, the bus after-commit listeners use, and the emit hooks. */
export function startBus(options: {
  logger: Logger;
  bus?: EventBus;
  beforeEmit?: readonly FeatureHook<AnyEvent | null, { operation: OperationInfo | undefined }>[];
  afterEmit?: readonly FeatureHook<AnyEvent, undefined>[];
}): void {
  shared.logger = options.logger;
  shared.bus = options.bus ?? shared.memory!;
  shared.beforeEmit = options.beforeEmit ?? [];
  shared.afterEmit = options.afterEmit ?? [];
  shared.enabled = true;
}

/** Stops the bus: removes every listener and refuses new ones until it starts again. */
export function stopBus(): void {
  shared.inTransaction.length = 0;
  shared.inTransactionLookup!.reset();
  for (const unsubscribe of shared.unsubscribes.splice(0)) unsubscribe();
  shared.memory!.clear();
  shared.bus = undefined;
  shared.beforeEmit = [];
  shared.afterEmit = [];
  shared.enabled = false;
}

/**
 * Runs `fn` in the scope of the event's tenant (`actor.tenant`) when tenancy runs and the caller is not in it already,
 * so listeners and deliveries of a tenant's events read and write that tenant's data.
 */
export function inEventTenant<T>(event: AnyEvent, fn: () => T | Promise<T>): Promise<T> | T {
  const tenant = event.actor?.tenant;
  if (tenant === undefined || !tenantRuns() || currentDatabaseScope().tenant?.id === tenant) return fn();
  return runForTenant(tenant, () => fn());
}

/** The actor and request id of the current operation. */
function operationFields(): { actor: EventActor; requestId?: string } {
  const operation = currentOperation();
  const actor: EventActor = {};
  const user = (operation?.req?.user as { id?: unknown } | undefined)?.id;
  // Outside requests (jobs, consumers), the tenant of the current database scope.
  const tenant = (operation?.req?.tenant as { id?: unknown } | undefined)?.id ?? currentDatabaseScope().tenant?.id;
  if (user !== undefined) actor.user = String(user);
  if (tenant !== undefined) actor.tenant = String(tenant);
  if (operation?.job) actor.job = operation.job.name;
  if (operation?.queue) actor.queue = operation.queue.name;
  if (operation?.scope) actor.scope = operation.scope;
  return { actor, ...(operation?.requestId ? { requestId: operation.requestId } : {}) };
}

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** Keeps the context of the span that created an event, while a tracer is set. */
function keepTrace(event: AnyEvent): void {
  if (!tracingEnabled()) return;
  const context = activeSpan()?.context();
  if (context) eventTraces.set(event, context);
}

/** Runs an after-commit listener in an internal span named `event <type>`, linked to the span that created the event. */
async function tracedListener(event: AnyEvent, run: () => unknown): Promise<void> {
  const link = eventTraces.get(event);
  const span = startSpan(`event ${event.type}`, { kind: "internal", parent: null, ...(link ? { links: [{ context: link }] } : {}) });
  try {
    await withSpan(span, run);
  } catch (error) {
    span.recordException(error);
    span.setStatus("error");
    throw error;
  } finally {
    span.end();
  }
}

/** The event of a reported write, with the actor and request of the current operation. */
export function toEvent(change: WriteChange): WriteEvent {
  const event = {
    id: Bun.randomUUIDv7(),
    type: `${lowerFirst(change.entity.entityName)}.${change.operation}`,
    entity: change.entity.entityName,
    operation: change.operation,
    recordId: change.id,
    before: change.before,
    after: change.after,
    changed: change.changed,
    cause: change.cause,
    ...operationFields(),
    at: new Date(),
  } as WriteEvent;
  keepTrace(event);
  return event;
}

/** The event after the `beforeEmit` hooks: changed (keeping its id, type and time) or null when one drops it. */
async function beforeEmit(event: AnyEvent): Promise<AnyEvent | null> {
  const context = { operation: currentOperation() };
  let current: AnyEvent = event;
  for (const hook of shared.beforeEmit) {
    const result = await hook(current, context);
    if (result === null) return null;
    if (result !== undefined) current = { ...result, id: event.id, type: event.type, at: event.at } as AnyEvent;
  }
  const trace = eventTraces.get(event);
  if (trace && current !== event) eventTraces.set(current, trace);
  return current;
}

/** The steps of an event inside its transaction: the `inTransaction` listeners, then the outbox row when stored. */
async function insideTransaction(event: AnyEvent, store: boolean): Promise<void> {
  for (const registration of shared.inTransactionLookup!.of(event.type)) await registration.listener(event);
  if (store) await insertOutboxRow(event);
}

/** Hands a committed event to the bus, then runs the `afterEmit` hooks. */
async function handOff(event: AnyEvent): Promise<void> {
  await shared.bus!.publish(event);
  if (shared.afterEmit.length > 0) await runAfterHooks(shared.afterEmit, event, undefined);
}

/**
 * Publishes an event: `beforeEmit` hooks first (which may change or drop it), then the `inTransaction` listeners,
 * awaited in registration order, then the outbox row when its type is chosen and `outbox` allows it; the bus gets it
 * once the transaction commits. Outside a transaction, a stored event gets a transaction of its own, and the bus gets
 * it at once.
 */
export async function publish(published: AnyEvent, outbox: boolean): Promise<void> {
  const event = shared.beforeEmit.length > 0 ? await beforeEmit(published) : published;
  if (!event) return;
  const store = outbox && storesType(event.type);
  // With the in-process bus and no afterEmit hook, an event no listener wants needs nothing after the commit.
  const handsOff = shared.bus !== shared.memory || shared.afterEmit.length > 0 || shared.memory!.hasListeners(event.type);
  if (inTransaction()) {
    await insideTransaction(event, store);
    if (handsOff) await afterCommit(() => handOff(event));
    return;
  }
  if (store) await inOutboxTransaction(() => insideTransaction(event, true));
  else await insideTransaction(event, false);
  if (handsOff) await handOff(event);
}
