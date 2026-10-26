import { readOutbox, type WriteEvent } from "../public.ts";

/**
 * Where change streams get their events: `subscribe` delivers the live write events of some entities (by name), and
 * `replay` the ones after an event id, oldest first, at most `limit` of them, or `"expired"` when the source no longer
 * keeps that id (`"unknown"` when it never had it).
 */
export interface ChangeSource {
  subscribe(entities: readonly string[], onEvent: (event: WriteEvent) => void): () => void;
  replay(entities: readonly string[], afterId: string, limit: number): Promise<WriteEvent[] | "expired" | "unknown">;
}

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether a text is an event id: a UUIDv7. */
export const isEventId = (id: string) => EVENT_ID.test(id);

/** The creation time of a UUIDv7, in milliseconds. */
export const timeOfEventId = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

/** The smallest UUIDv7 of a millisecond, below every id created at or after it. */
export function eventIdFloor(ms: number): string {
  const hex = Math.max(0, ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/** The subscribers of a source, by entity name. */
function subscribers() {
  const byEntity = new Map<string, Set<(event: WriteEvent) => void>>();
  return {
    add(entities: readonly string[], fn: (event: WriteEvent) => void) {
      for (const entity of entities) {
        let set = byEntity.get(entity);
        if (!set) byEntity.set(entity, (set = new Set()));
        set.add(fn);
      }
      return () => {
        for (const entity of entities) {
          const set = byEntity.get(entity);
          set?.delete(fn);
          if (set?.size === 0) byEntity.delete(entity);
        }
      };
    },
    deliver(event: WriteEvent) {
      for (const fn of [...(byEntity.get(event.entity) ?? [])]) fn(event);
    },
    size: () => byEntity.size,
  };
}

/**
 * The in-process source: the last `size` committed write events of the covered entities, fed by `push` from an
 * after-commit listener, so a client reconnecting to this worker gets what it missed.
 */
export function ringBufferSource(size: number) {
  const buffer: WriteEvent[] = [];
  /** Whether an event was ever dropped to make room. */
  let dropped = false;
  const listeners = subscribers();
  const source: ChangeSource & { push(event: WriteEvent): void } = {
    push(event) {
      buffer.push(event);
      if (buffer.length > size) {
        buffer.shift();
        dropped = true;
      }
      listeners.deliver(event);
    },
    subscribe: (entities, onEvent) => listeners.add(entities, onEvent),
    async replay(entities, afterId, limit) {
      const at = buffer.findIndex((event) => event.id === afterId);
      if (at < 0) {
        const oldest = buffer[0];
        return dropped && (!oldest || timeOfEventId(afterId) <= timeOfEventId(oldest.id)) ? "expired" : "unknown";
      }
      return buffer.slice(at + 1).filter((event) => entities.includes(event.entity)).slice(0, limit);
    },
  };
  return source;
}

/** How far before its cursor a poll re-reads the outbox: ids follow creation, not commit, so late commits land behind it. */
export const POLL_OVERLAP_MS = 5000;

const PAGE = 1000;

/**
 * The outbox source: the write events every worker and replica committed, read from the outbox log. Polls every
 * `pollMs` only while it has subscribers, re-reading a 5-second overlap and skipping ids it already delivered.
 */
export function outboxSource(settings: {
  pollMs: number;
  /** The outbox retention in milliseconds: older ids are expired. */
  retentionMs: number;
  /** Logs a failed poll; the next one runs at the next interval. */
  onPollFailed: (error: unknown) => void;
  now?: () => number;
  read?: typeof readOutbox;
}): ChangeSource & { polling(): boolean } {
  const read = settings.read ?? readOutbox;
  const now = settings.now ?? Date.now;
  const listeners = subscribers();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /** Ids delivered within the overlap, with their times. */
  const seen = new Map<string, number>();
  let cursor = "";
  let start = "";
  const poll = async () => {
    let after = eventIdFloor(Math.max(timeOfEventId(cursor), timeOfEventId(start)) - POLL_OVERLAP_MS);
    for (;;) {
      const page = await read({ after, limit: PAGE });
      for (const record of page) {
        if (record.id <= start || seen.has(record.id)) continue;
        seen.set(record.id, timeOfEventId(record.id));
        if (record.id > cursor) cursor = record.id;
        const event = record.event as WriteEvent;
        if (typeof (event as { entity?: unknown }).entity === "string") listeners.deliver(event);
      }
      if (page.length < PAGE) break;
      after = page.at(-1)!.id;
    }
    const oldest = timeOfEventId(cursor || start) - POLL_OVERLAP_MS;
    for (const [id, time] of seen) if (time < oldest) seen.delete(id);
  };
  const loop = async () => {
    if (!running) return;
    try {
      await poll();
    } catch (error) {
      settings.onPollFailed(error);
    }
    if (running) timer = setTimeout(loop, settings.pollMs);
  };
  const startPolling = () => {
    running = true;
    // Only the events created from now on are live; earlier ones are replayed by id. Ids of one process grow
    // monotonically, so a fresh id separates the writes before and after it.
    start = settings.now ? eventIdFloor(now()) : Bun.randomUUIDv7();
    cursor = "";
    seen.clear();
    timer = setTimeout(loop, settings.pollMs);
  };
  const stopPolling = () => {
    running = false;
    clearTimeout(timer);
  };
  return {
    subscribe(entities, onEvent) {
      const remove = listeners.add(entities, onEvent);
      if (!running) startPolling();
      return () => {
        remove();
        if (listeners.size() === 0) stopPolling();
      };
    },
    async replay(entities, afterId, limit) {
      const time = timeOfEventId(afterId);
      if (time < now() - settings.retentionMs) return "expired";
      // The id must be one the log holds; ids of one millisecond are read together.
      const sameMillisecond = await read({ after: eventIdFloor(time), limit: PAGE });
      if (!sameMillisecond.some((record) => record.id === afterId)) return "unknown";
      const found: WriteEvent[] = [];
      let after = afterId;
      for (;;) {
        const page = await read({ after, limit: PAGE });
        for (const record of page) {
          const event = record.event as WriteEvent;
          if (entities.includes(event.entity)) found.push(event);
          if (found.length >= limit) return found;
        }
        if (page.length < PAGE) return found;
        after = page.at(-1)!.id;
      }
    },
    polling: () => running,
  };
}
