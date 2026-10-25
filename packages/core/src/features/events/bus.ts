import {
  afterCommit,
  currentOperation,
  inTransaction,
  jsonLogger,
  safeLog,
  type AnyEvent,
  type CustomEvent,
  type EventActor,
  type EventFor,
  type Logger,
  type PayloadOf,
  type WriteChange,
  type WriteEvent,
} from "../public.ts";
import * as patterns from "./patterns.ts";

/** When a listener runs: inside the write's transaction (awaited, may veto it) or after the commit (the default). */
export type ListenerPhase = "afterCommit" | "inTransaction";

export interface ListenOptions {
  phase?: ListenerPhase;
}

export type EventListener<E = AnyEvent> = (event: E) => void | Promise<void>;

interface Registration {
  pattern: patterns.CompiledPattern;
  listener: EventListener;
  phase: ListenerPhase;
  /** Deliveries of this listener chain one after the other, in commit order. */
  tail: Promise<void>;
  active: boolean;
}

const registrations: Registration[] = [];
/** The listeners of each phase and type, found once per type and kept until the listeners change. */
let byType = new Map<string, Registration[]>();
const pending = new Set<Promise<void>>();
let logger: Logger = jsonLogger;
const notEnabled = () => {
  throw new Error("events is not enabled; add events: {} to quickservice.config.ts");
};
/** Refuses work while the native is not running. */
let enabledCheck: () => void = notEnabled;

function listenersOf(type: string, phase: ListenerPhase): Registration[] {
  const key = `${phase}\u0000${type}`;
  let found = byType.get(key);
  if (!found) {
    found = registrations.filter((registration) => registration.phase === phase && patterns.patternMatches(registration.pattern, type));
    byType.set(key, found);
  }
  return found;
}

/** Hands an event to the after-commit listeners without waiting for them; each gets its events one at a time. */
function deliver(event: AnyEvent): void {
  for (const registration of listenersOf(event.type, "afterCommit")) {
    const delivery = registration.tail.then(async () => {
      if (!registration.active) return;
      try {
        await registration.listener(event);
      } catch (error) {
        safeLog(logger, "error", {
          timestamp: new Date().toISOString(),
          message: "event.listener.failed",
          type: event.type,
          eventId: event.id,
          error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) },
        });
      }
    });
    registration.tail = delivery;
    pending.add(delivery);
    void delivery.finally(() => pending.delete(delivery));
  }
}

/** The bus of the `events` native: write events and custom events, delivered to listeners by pattern. */
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
  /** Resolves once every after-commit delivery started so far has finished. */
  idle(): Promise<void>;
}

const register = (pattern: string, listener: EventListener, options: ListenOptions = {}) => {
  enabledCheck();
  const registration: Registration = { pattern: patterns.compilePattern(pattern), listener, phase: options.phase ?? "afterCommit", tail: Promise.resolve(), active: true };
  registrations.push(registration);
  byType = new Map();
  return () => {
    registration.active = false;
    const at = registrations.indexOf(registration);
    if (at >= 0) registrations.splice(at, 1);
    byType = new Map();
  };
};

export const events: Events = {
  on: (pattern, listener, options) => register(pattern, listener as EventListener, options),
  async emit(type, payload) {
    enabledCheck();
    patterns.assertCustomType(type);
    const event: CustomEvent = { id: Bun.randomUUIDv7(), type, payload, ...operationFields(), at: new Date() };
    await publish(event);
    return event.id;
  },
  async idle() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  },
};

/** The number of after-commit deliveries not finished yet. */
export const pendingDeliveries = () => pending.size;

/** Starts the bus for a running service, with its logger. */
export function startBus(options: { logger: Logger }): void {
  logger = options.logger;
  enabledCheck = () => {};
}

/** Stops the bus: removes every listener and refuses new ones until it starts again. */
export function stopBus(): void {
  for (const registration of registrations) registration.active = false;
  registrations.length = 0;
  byType = new Map();
  enabledCheck = notEnabled;
}

/** The actor and request id of the current operation. */
function operationFields(): { actor: EventActor; requestId?: string } {
  const operation = currentOperation();
  const actor: EventActor = {};
  const user = (operation?.req?.user as { id?: unknown } | undefined)?.id;
  const tenant = (operation?.req?.tenant as { id?: unknown } | undefined)?.id;
  if (user !== undefined) actor.user = String(user);
  if (tenant !== undefined) actor.tenant = String(tenant);
  if (operation?.job) actor.job = operation.job.name;
  if (operation?.queue) actor.queue = operation.queue.name;
  return { actor, ...(operation?.requestId ? { requestId: operation.requestId } : {}) };
}

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** The event of a reported write, with the actor and request of the current operation. */
export function toEvent(change: WriteChange): WriteEvent {
  return {
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
}

/**
 * Publishes an event: the `inTransaction` listeners run at once, awaited in registration order, and the after-commit
 * listeners get it once the transaction commits (at once outside one).
 */
export async function publish(event: AnyEvent): Promise<void> {
  for (const registration of listenersOf(event.type, "inTransaction")) await registration.listener(event);
  if (listenersOf(event.type, "afterCommit").length === 0) return;
  if (inTransaction()) await afterCommit(() => deliver(event));
  else deliver(event);
}
