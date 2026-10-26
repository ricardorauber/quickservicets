import type { EntityModel, FileAccessSettings, SseStream, WriteEvent } from "../public.ts";
import { changeMessage, type ChangeQuery } from "./changes.ts";
import { isEventId, type ChangeSource } from "./source.ts";

/** The most missed events a reconnecting stream gets; more send a `reset`. */
export const MAX_REPLAY = 10_000;

/** How long browsers wait before reconnecting, sent in the first message of every change stream. */
export const RETRY_MS = 3000;

/** Why a stream asks its client to reload instead of replaying. */
export type ResetReason = "unknown-id" | "expired" | "too-many";

/**
 * Follows an entity's changes on an open stream: with a last event id, first the missed events matching the stream's
 * query, in order, then the live ones, without gaps or duplicates between the two; a `reset` message when the missed
 * events cannot be replayed. The first message carries `retry: 3000`.
 */
export async function followChanges(stream: SseStream, options: { entity: EntityModel; query: ChangeQuery; source: ChangeSource; lastEventId?: string; files?: FileAccessSettings }): Promise<void> {
  const { entity, query, source } = options;
  let first = true;
  const write = (data: unknown, event: string, id?: string) => {
    stream.send(data, { event, ...(id !== undefined ? { id } : {}), ...(first ? { retry: RETRY_MS } : {}) });
    first = false;
  };
  const replayed = new Set<string>();
  let live = false;
  const pending: WriteEvent[] = [];
  // Messages go out in order, one after the other.
  let queue = Promise.resolve();
  const deliver = (event: WriteEvent) => {
    if (replayed.has(event.id)) return;
    queue = queue.then(async () => {
      const message = await changeMessage(event, entity, query, options.files);
      if (message) write(message.data, message.event, message.id);
    });
  };
  // Live events are collected from now on, so none is lost while the missed ones are read.
  const unsubscribe = source.subscribe([entity.entityName], (event) => (live ? deliver(event) : pending.push(event)));
  stream.signal.addEventListener("abort", unsubscribe, { once: true });
  const reset = (reason: ResetReason) => write({ reason }, "reset");
  if (options.lastEventId !== undefined) {
    if (!isEventId(options.lastEventId)) reset("unknown-id");
    else {
      const missed = await source.replay([entity.entityName], options.lastEventId, MAX_REPLAY + 1);
      if (missed === "expired") reset("expired");
      else if (missed === "unknown") reset("unknown-id");
      else if (missed.length > MAX_REPLAY) reset("too-many");
      else
        for (const event of missed) {
          replayed.add(event.id);
          const message = await changeMessage(event, entity, query, options.files);
          if (message) write(message.data, message.event, message.id);
        }
    }
  }
  live = true;
  for (const event of pending.splice(0)) deliver(event);
  await queue;
}
