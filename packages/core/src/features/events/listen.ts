import type { EventFor, Logger, Repositories } from "../public.ts";
import type { ListenOptions } from "./bus.ts";

/** What a listener file's listener receives besides the event. */
export interface ListenerContext {
  /** The service's repositories. */
  repos: Repositories;
  /** The service's logger, adding `listener: <file name>` to each entry. */
  log: Logger;
}

const LISTENER = Symbol.for("quickservicets.events.listener");

/** A listener declared by a file of `events/`. */
export interface ListenerFile<P extends string = string> {
  readonly [LISTENER]: true;
  readonly pattern: P;
  readonly listener: (event: EventFor<P>, ctx: ListenerContext) => void | Promise<void>;
  readonly options: ListenOptions;
}

/**
 * Declares the listener of a file in `events/`, registered by the `events` native without any other code:
 *
 * ```ts
 * export default listen("user.created", async (event, { repos }) => {
 *   await repos.notes.create({ text: event.after.email });
 * });
 * ```
 */
export function listen<P extends string>(pattern: P, listener: (event: EventFor<P>, ctx: ListenerContext) => void | Promise<void>, options: ListenOptions = {}): ListenerFile<P> {
  return { [LISTENER]: true, pattern, listener, options };
}

/** Whether a value is what `listen(...)` returns. */
export function isListenerFile(value: unknown): value is ListenerFile {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[LISTENER] === true;
}
