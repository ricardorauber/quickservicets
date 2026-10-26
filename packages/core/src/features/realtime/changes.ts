import {
  entityRoutePath,
  HttpError,
  matchesConditions,
  parseClientSelection,
  parseListQuery,
  selectFields,
  withFileUrls,
  type Condition,
  type EntityModel,
  type FieldErrorDetail,
  type FileAccessSettings,
  type OpenApiDoc,
  type StoredRecord,
  type WriteEvent,
} from "../public.ts";

/** Which entities get a change stream: those tagged `@changes`, or every entity with generated list routes. */
export type ChangeCoverage = "tagged" | "all";

/** The write operations a change stream sends. */
export const CHANGE_EVENTS = ["created", "updated", "deleted"] as const;
export type ChangeEvent = (typeof CHANGE_EVENTS)[number];

/** Whether an entity has a change stream: `@changes` covers it and `@changes off` excludes it. */
export function hasChangeStream(entity: EntityModel, coverage: ChangeCoverage): boolean {
  if (entity.internal || entity.system || entity.link) return false;
  const tag = entity.tags?.changes;
  if (tag) return tag.on;
  return coverage === "all";
}

/** The entities of a model with a change stream. */
export const changeEntities = (models: readonly EntityModel[], coverage: ChangeCoverage) => models.filter((entity) => hasChangeStream(entity, coverage));

/** The path of an entity's change stream: `/tasks/changes`. */
export const changesPath = (entity: EntityModel) => `${entityRoutePath(entity)}/changes`;

/** What a change stream sends: the filters, the event types and the client's field selection. */
export interface ChangeQuery {
  where: Condition[];
  events: ChangeEvent[];
  selection: { fields?: string[]; exclude?: string[] };
}

const PAGING = ["sort", "limit", "offset", "populate"];

/**
 * The query of a change stream: `where[...]` filters as the list route takes them, `fields`, `exclude` and `events`
 * (a comma-separated subset of created, updated and deleted); `sort`, `limit`, `offset` and `populate` fail with 400.
 */
export function parseChangeQuery(entity: EntityModel, params: URLSearchParams, models: readonly EntityModel[], allowed: readonly ChangeEvent[] = CHANGE_EVENTS): ChangeQuery {
  const details: FieldErrorDetail[] = [];
  const rest = new URLSearchParams();
  let events: ChangeEvent[] = [...allowed];
  for (const [key, value] of params) {
    if (PAGING.includes(key)) details.push({ field: key, message: "Unknown parameter" });
    else if (key === "events") {
      const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
      const invalid = names.filter((name) => !(allowed as readonly string[]).includes(name));
      if (names.length === 0 || invalid.length > 0) details.push({ field: "events", message: `Must list ${allowed.join(", ")}` });
      else events = [...new Set(names)] as ChangeEvent[];
    } else rest.append(key, value);
  }
  if (details.length > 0) throw new HttpError(400, "Invalid query", { details });
  const { where } = parseListQuery(entity, rest);
  const selection = parseClientSelection(entity, "list", rest, { populated: [], models: [...models] });
  return { where, events, selection };
}

/** A message of a change stream, before it is written. */
export interface ChangeMessage {
  event: ChangeEvent;
  id: string;
  data: { id: string; type: string; record: unknown; matches?: false };
}

/**
 * The message a write event becomes for one stream, or undefined when the stream does not want it: creates whose
 * record matches the filters, deletes whose former record matched, and updates where either side matches, with
 * `matches: false` when the record no longer matches. The record is projected as the list route returns it.
 */
export async function changeMessage(event: WriteEvent, entity: EntityModel, query: ChangeQuery, files?: FileAccessSettings): Promise<ChangeMessage | undefined> {
  const operation = event.operation as ChangeEvent;
  if (!query.events.includes(operation)) return undefined;
  const matches = (record: StoredRecord | null) => record !== null && matchesConditions(record, query.where, entity);
  const before = operation === "created" ? false : matches(event.before);
  const after = operation === "deleted" ? false : matches(event.after);
  if (operation === "created" && !after) return undefined;
  if (operation === "deleted" && !before) return undefined;
  if (operation === "updated" && !before && !after) return undefined;
  const stored = (operation === "deleted" ? event.before : event.after)!;
  const [withUrl] = await withFileUrls(entity, [stored], files);
  // A stream's records always keep their id, so clients can match them with the list they hold.
  const selection = query.selection.fields && !query.selection.fields.includes("id") ? { ...query.selection, fields: ["id", ...query.selection.fields] } : query.selection;
  const record = selectFields(withUrl, entity.exposure.list, selection);
  return { event: operation, id: event.id, data: { id: event.recordId, type: event.type, record, ...(operation === "updated" && !after ? { matches: false as const } : {}) } };
}

type Operation = { tags?: string[]; parameters?: { name: string; in: string }[]; responses?: Record<string, { content?: Record<string, { schema?: { properties?: { data?: { items?: unknown } } } }> }> };

/** Documents each change stream route with its query parameters and a `text/event-stream` response. */
export function documentChanges(doc: OpenApiDoc, entities: readonly EntityModel[]): OpenApiDoc {
  for (const entity of entities) {
    const collection = entityRoutePath(entity);
    const list = (doc.paths[collection] as Record<string, Operation> | undefined)?.get;
    if (!list) continue;
    const item = list.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.data?.items ?? { type: "object" };
    const parameters = (list.parameters ?? []).filter((parameter) => parameter.in === "query" && !["limit", "offset", "sort", "populate"].includes(parameter.name));
    doc.paths[`${collection}/changes`] = {
      get: {
        tags: list.tags ?? [],
        operationId: `changes${entity.entityName}`,
        summary: `Follow the changes of ${entity.name} live`,
        description:
          "A stream of Server-Sent Events: `created`, `updated` and `deleted`, each with the write event's id and the data `{ id, type, record }`, where `record` is shaped like a list item; an `updated` record that no longer matches the filters carries `matches: false`.",
        parameters: [...parameters, { name: "events", in: "query", description: "Comma-separated event names: created, updated, deleted.", schema: { type: "string" } }],
        responses: {
          "200": {
            description: "A stream of Server-Sent Events",
            content: {
              "text/event-stream": {
                schema: {
                  type: "object",
                  required: ["id", "type", "record"],
                  properties: { id: { type: "string" }, type: { type: "string" }, record: item, matches: { type: "boolean", enum: [false] } },
                },
              },
            },
          },
          "400": { description: "Invalid query", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    };
  }
  return doc;
}

/** Delivers the write events of each entity to its open change streams. */
export interface ChangeHub {
  /** Calls `fn` with each committed write event of the entity until the returned function is called. */
  subscribe(entity: EntityModel, fn: (event: WriteEvent) => void): () => void;
  /** The entities with at least one subscriber, by name. */
  active(): string[];
}

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * A hub listening to an entity's events (after commit) only while a stream of that entity is open, so writes of
 * entities without open streams cost nothing.
 */
export function changeHub(listen: (pattern: string, listener: (event: WriteEvent) => void) => () => void): ChangeHub {
  const subscribers = new Map<string, { fns: Set<(event: WriteEvent) => void>; stop: () => void }>();
  return {
    subscribe(entity, fn) {
      let entry = subscribers.get(entity.entityName);
      if (!entry) {
        const fns = new Set<(event: WriteEvent) => void>();
        const stop = listen(`${lowerFirst(entity.entityName)}.written`, (event) => {
          for (const subscriber of [...fns]) subscriber(event);
        });
        entry = { fns, stop };
        subscribers.set(entity.entityName, entry);
      }
      const current = entry;
      current.fns.add(fn);
      return () => {
        current.fns.delete(fn);
        if (current.fns.size === 0 && subscribers.get(entity.entityName) === current) {
          subscribers.delete(entity.entityName);
          current.stop();
        }
      };
    },
    active: () => [...subscribers.keys()],
  };
}
