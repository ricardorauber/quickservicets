/**
 * Thrown by a trigger's handler to drop an event that will never succeed, like a file that is not an image: the event
 * ends `discarded`, acknowledged without a retry and logged with the reason.
 */
export class TriggerDiscard extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TriggerDiscard";
  }
}

/** Whether a value is a `TriggerDiscard`, also one thrown by another copy of the core. */
export function isTriggerDiscard(value: unknown): value is TriggerDiscard {
  return value instanceof TriggerDiscard || (value instanceof Error && value.name === "TriggerDiscard" && typeof (value as { reason?: unknown }).reason === "string");
}
