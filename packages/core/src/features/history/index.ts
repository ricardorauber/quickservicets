import { defineFeature, HttpError, object, oneOf, resolveRouteHooks, type Repositories, type ServiceRequest, type WriteEvent } from "../public.ts";
import { coveredEntities, excludedFields, historyModelKey, historyModels, snapshotOf, type HistoryOperation } from "./model.ts";
import { documentHistory, hiddenPathsOf, historyPaths, listAnswer, parseVersionNumber, parseVersionQuery, versionResponse } from "./routes.ts";
import { getVersion, listVersions, writeVersion, type NewVersion } from "./store.ts";

const options = object({
  entities: oneOf(["tagged", "all"])
    .default("tagged")
    .describe("Which entities keep history: tagged keeps it for entities tagged @history, all for every regular entity without @history off."),
});

const OPERATIONS: Record<WriteEvent["operation"], HistoryOperation> = { created: "create", updated: "update", deleted: "delete" };

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** Who made a write: the request's user, else the job or queue it ran for, else the system. */
export function actorOf(event: Pick<WriteEvent, "actor">): string {
  if (event.actor.user !== undefined) return `user:${event.actor.user}`;
  if (event.actor.job !== undefined) return `job:${event.actor.job}`;
  if (event.actor.queue !== undefined) return `queue:${event.actor.queue}`;
  return "system";
}

/** The version a write event becomes, without its number. */
export function versionOf(event: WriteEvent, excluded: readonly string[]): NewVersion {
  const record = event.operation === "deleted" ? event.before : event.after;
  return {
    entityId: event.recordId,
    operation: OPERATIONS[event.operation],
    actor: actorOf(event),
    ...(event.actor.tenant !== undefined ? { tenant: event.actor.tenant } : {}),
    ...(event.requestId ? { requestId: event.requestId } : {}),
    at: event.at instanceof Date ? event.at : new Date(event.at),
    record: snapshotOf(record, excluded),
    changed: [...event.changed],
  };
}

/**
 * The `history` native: every write of a chosen entity stores a version of the record in its `<entity>_history`
 * table, in the write's own transaction, with who made it, when and the full record. Off unless `history: {}` (or
 * `QS_HISTORY_ENABLED=true`) is set; it needs `events`.
 */
const historyFeature = defineFeature({
  key: "history",
  docs: { summary: "Every version of the records of chosen entities, kept in a history table written in the same transaction as the change." },
  requires: ["events"],
  options,
  // One read-only system entity per covered entity; nothing when the native is off.
  entities: ({ models, options }) => historyModels(models, options.entities),
  tags: {
    history: {
      on: ["entity", "field"],
      description:
        "`@history` on an entity keeps its versions and `@history off` excludes it; on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them.",
      example: "/** @history */\nexport type Contract = {\n  title: string;\n  /** @history off */\n  draftNotes: string;\n};",
    },
  },
  setup(ctx) {
    const adapter = ctx.config.database;
    const unsubscribes: (() => void)[] = [];
    for (const entity of coveredEntities(ctx.models, ctx.options.entities)) {
      const model = ctx.models.find((candidate) => candidate.key === historyModelKey(entity) && candidate.system);
      if (!model) throw new Error(`History needs the ${historyModelKey(entity)} entity; run quickservice build after enabling history`);
      const excluded = excludedFields(entity);
      if (!entity.internal && !entity.system && !entity.link) {
        // The routes run the hooks of the entity's read route, so whoever may not read a record may not read its history.
        const hooks = resolveRouteHooks({ kind: "generated", entity, operation: "read" });
        const hidden = hiddenPathsOf(entity);
        const paths = historyPaths(entity);
        ctx.app.route(
          "GET",
          paths.list,
          async (_repos: Repositories, req: ServiceRequest) => {
            const query = parseVersionQuery(req.query);
            const id = req.params.id!;
            const page = await listVersions(adapter, model, id, query);
            const anyVersion = page.total > 0 || (query.where.length > 0 && (await listVersions(adapter, model, id, { where: [], limit: 1, offset: 0 })).total > 0);
            return listAnswer(entity, page, query, hidden, anyVersion);
          },
          { hooks },
        );
        ctx.app.route(
          "GET",
          paths.version,
          async (_repos: Repositories, req: ServiceRequest) => {
            const number = parseVersionNumber(req.params.version);
            const version = await getVersion(adapter, model, req.params.id!, number);
            if (!version) throw new HttpError(404, `${entity.entityName} version ${number} not found`);
            return versionResponse(version, hidden);
          },
          { hooks },
        );
      }
      // One listener per covered entity, so writes of other entities never reach the native.
      unsubscribes.push(
        ctx.events.on(
          `${lowerFirst(entity.entityName)}.written`,
          async (event) => {
            await writeVersion(adapter, model, versionOf(event as WriteEvent, excluded));
          },
          { phase: "inTransaction" },
        ),
      );
    }
    ctx.app.onStop(() => {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    });
  },
  openapi(doc, { models, options }) {
    return documentHistory(
      doc,
      coveredEntities(models, options.entities).filter((entity) => !entity.internal && !entity.system && !entity.link),
    );
  },
});

export default historyFeature;
export { historyFeature };
export { coveredEntities, excludedFields, historyModel, historyModelKey, historyModels, isCovered, snapshotOf } from "./model.ts";
export { getVersion, listVersions, writeVersion } from "./store.ts";
export type { HistoryCoverage, HistoryOperation, HistoryVersion } from "./model.ts";
export type { NewVersion, VersionPage, VersionQuery } from "./store.ts";
