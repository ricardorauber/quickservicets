import { afterCommit, currentOperation, inTransaction, jsonLogger, safeLog, type Logger, type StoredRecord, type WriteChange } from "../public.ts";

/** Who caused an event: ids of the request's user and tenant, or the job or queue it ran for. */
export interface EventActor {
  user?: string;
  tenant?: string;
  job?: string;
  queue?: string;
}

/** A record created, updated or deleted by a repository write. */
export interface WriteEvent<T = StoredRecord> {
  /** A UUIDv7, in creation order. */
  id: string;
  /** `<entity in lower camel case>.<operation>`, like `user.created` or `orderItem.deleted`. */
  type: string;
  /** The entity's name, like `User`. */
  entity: string;
  operation: "created" | "updated" | "deleted";
  recordId: string;
  /** The stored record before the write; null for a create. */
  before: T | null;
  /** The stored record after the write; null for a delete. */
  after: T | null;
  /** The top-level fields whose stored values changed, `updatedAt` excluded. */
  changed: string[];
  cause: WriteChange["cause"];
  actor: EventActor;
  requestId?: string;
  at: Date;
}

/** When a listener runs: inside the write's transaction (awaited, may veto it) or after the commit (the default). */
export type ListenerPhase = "afterCommit" | "inTransaction";

export interface ListenOptions {
  phase?: ListenerPhase;
}

export type EventListener<E = WriteEvent> = (event: E) => void | Promise<void>;

interface Registration {
  type: string;
  listener: EventListener;
  phase: ListenerPhase;
  /** Deliveries of this listener chain one after the other, in commit order. */
  tail: Promise<void>;
  active: boolean;
}

const registrations: Registration[] = [];
/** The listeners of each type and phase, rebuilt when listeners change. */
let byType = new Map<string, Registration[]>();
const pending = new Set<Promise<void>>();
let logger: Logger = jsonLogger;
/** Set while the native is enabled; `events` refuses to work otherwise. */
let enabledCheck: () => void = () => {
  throw new Error("events is not enabled; add events: {} to quickservice.config.ts");
};

const changed = () => {
  byType = new Map();
};

function listenersOf(type: string, phase: ListenerPhase): Registration[] {
  const key = `${phase}\u0000${type}`;
  let found = byType.get(key);
  if (!found) {
    found = registrations.filter((registration) => registration.phase === phase && (registration.type === "*" || registration.type === type));
    byType.set(key, found);
  }
  return found;
}

/** Hands an event to the after-commit listeners without waiting for them; each gets its events one at a time. */
function deliver(event: WriteEvent): void {
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

/** The bus of the `events` native: listeners of write events, in the write's transaction or after its commit. */
export interface Events {
  /**
   * Registers a listener for an exact event type or `*` (every event) and returns a function that removes it.
   * `afterCommit` listeners (the default) get each event after the outermost commit, never for a rolled-back write;
   * `inTransaction` listeners run inside the write's transaction, and a throw rolls the write back.
   */
  on(type: string, listener: EventListener, options?: ListenOptions): () => void;
  /** Resolves once every after-commit delivery started so far has finished. */
  idle(): Promise<void>;
}

export const events: Events = {
  on(type, listener, options = {}) {
    enabledCheck();
    const registration: Registration = { type, listener, phase: options.phase ?? "afterCommit", tail: Promise.resolve(), active: true };
    registrations.push(registration);
    changed();
    return () => {
      registration.active = false;
      const at = registrations.indexOf(registration);
      if (at >= 0) registrations.splice(at, 1);
      changed();
    };
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
  changed();
  enabledCheck = () => {
    throw new Error("events is not enabled; add events: {} to quickservice.config.ts");
  };
}

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** The event of a reported write, with the actor and request of the current operation. */
export function toEvent(change: WriteChange): WriteEvent {
  const operation = currentOperation();
  const actor: EventActor = {};
  const user = (operation?.req?.user as { id?: unknown } | undefined)?.id;
  const tenant = (operation?.req?.tenant as { id?: unknown } | undefined)?.id;
  if (user !== undefined) actor.user = String(user);
  if (tenant !== undefined) actor.tenant = String(tenant);
  if (operation?.job) actor.job = operation.job.name;
  if (operation?.queue) actor.queue = operation.queue.name;
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
    actor,
    ...(operation?.requestId ? { requestId: operation.requestId } : {}),
    at: new Date(),
  };
}

/**
 * Publishes an event: the `inTransaction` listeners run at once, awaited in registration order, and the after-commit
 * listeners get it once the transaction commits (at once outside one).
 */
export async function publish(event: WriteEvent): Promise<void> {
  for (const registration of listenersOf(event.type, "inTransaction")) await registration.listener(event);
  if (listenersOf(event.type, "afterCommit").length === 0) return;
  if (inTransaction()) await afterCommit(() => deliver(event));
  else deliver(event);
}
