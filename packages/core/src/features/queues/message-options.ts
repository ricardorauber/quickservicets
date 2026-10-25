import { parseDuration } from "../public.ts";
import type { QueueAddOptions } from "./queue.ts";

/** The lowest and highest message priority. */
export const PRIORITY_RANGE = [-100, 100] as const;

/** When and in which order a message runs, as `add` stores it. */
export interface MessagePlacement {
  runAt: Date;
  priority: number;
  /** At most one live message of the queue has this key. */
  dedupeKey?: string;
}

const invalid = (reason: string) => new Error(`Invalid queue options: ${reason}`);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Checks the options of an `add` call and computes when and in which order its message runs; throws on bad options. */
export function messagePlacement(options: QueueAddOptions | undefined, now: number): MessagePlacement {
  const { delay, runAt, priority = 0, dedupeKey } = options ?? {};
  if (dedupeKey !== undefined && (typeof dedupeKey !== "string" || dedupeKey.length < 1 || dedupeKey.length > 255)) throw invalid("dedupeKey must be 1 to 255 characters");
  const keyed = dedupeKey === undefined ? {} : { dedupeKey };
  if (delay !== undefined && runAt !== undefined) throw invalid("give delay or runAt, not both");
  if (!Number.isInteger(priority) || priority < PRIORITY_RANGE[0] || priority > PRIORITY_RANGE[1]) {
    throw invalid(`priority must be an integer from ${PRIORITY_RANGE[0]} to ${PRIORITY_RANGE[1]}`);
  }
  if (delay !== undefined) {
    const ms = parseDuration(delay);
    if (ms === undefined) throw invalid(`delay must be a duration that is not negative, like 5m; got ${JSON.stringify(delay)}`);
    return { runAt: new Date(now + ms), priority, ...keyed };
  }
  if (runAt !== undefined) {
    const at = runAt instanceof Date ? runAt : typeof runAt === "string" && ISO_DATE_TIME.test(runAt) ? new Date(runAt) : undefined;
    if (!at || Number.isNaN(at.getTime())) throw invalid(`runAt must be a Date or an ISO 8601 date-time with an offset; got ${JSON.stringify(runAt)}`);
    return { runAt: at, priority, ...keyed };
  }
  return { runAt: new Date(now), priority, ...keyed };
}
