import type { EntityModel, WriteEvent } from "../public.ts";

/** The write operations an entity tagged `@publish` may send to a queue. */
export const PUBLISH_OPERATIONS = ["created", "updated", "deleted"] as const;
export type PublishOperation = (typeof PUBLISH_OPERATIONS)[number];

/** How one entity publishes its write events, from its `@publish` tag over `queues.publish`. */
export interface PublishSettings {
  queue: string;
  events: readonly PublishOperation[];
  /** The fields kept in `before` and `after`, with `id`; all but hidden and sensitive ones without it. */
  fields?: readonly string[];
}

/** The fields of an entity that a published event leaves out: `@hidden` and `@sensitive` ones. */
function concealedFields(model: EntityModel): Set<string> {
  return new Set(model.fields.filter((field) => field.hidden === true || field.tags?.sensitive?.on === true).map((field) => field.name));
}

/** A record as a published event carries it: only `fields` and `id` when given, otherwise without concealed fields. */
function project(record: unknown, settings: PublishSettings, concealed: Set<string>): unknown {
  if (record === null || typeof record !== "object") return record;
  const entries = Object.entries(record as Record<string, unknown>);
  if (settings.fields) {
    const kept = new Set(["id", ...settings.fields]);
    return Object.fromEntries(entries.filter(([name]) => kept.has(name)));
  }
  return Object.fromEntries(entries.filter(([name]) => !concealed.has(name)));
}

/** Builds the payload of the messages an entity publishes: the write event with its records projected. */
export function publishedPayload(model: EntityModel, settings: PublishSettings): (event: WriteEvent) => Record<string, unknown> {
  const concealed = concealedFields(model);
  return (event) => ({
    id: event.id,
    type: event.type,
    entity: event.entity,
    operation: event.operation,
    recordId: event.recordId,
    before: project(event.before, settings, concealed),
    after: project(event.after, settings, concealed),
    changed: settings.fields ? event.changed.filter((name) => settings.fields!.includes(name)) : event.changed.filter((name) => !concealed.has(name)),
    cause: event.cause,
    ...(event.actor !== undefined ? { actor: event.actor } : {}),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    at: event.at,
  });
}
