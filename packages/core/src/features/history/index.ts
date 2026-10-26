import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  afterCommit,
  defineFeature,
  duration,
  hook,
  HttpError,
  object,
  oneOf,
  provider,
  resolveRouteHooks,
  runAfterHooks,
  type Repositories,
  type ServiceRequest,
  type WriteEvent,
} from "../public.ts";
import type { HistoryApi, HistoryStore, HistoryVersionStep, HistoryWrittenVersion } from "./api.ts";
import { historyCommands, pruneStores, pruneTargets } from "./commands.ts";
import { coveredEntities, excludedFields, historyModels, snapshotOf, type HistoryOperation, type HistoryVersion } from "./model.ts";
import { setRunningPrune } from "./prune.ts";
import { documentHistory, hiddenPathsOf, historyPaths, listAnswer, parseVersionNumber, parseVersionQuery, versionResponse } from "./routes.ts";
import type { NewVersion } from "./store.ts";

const options = object({
  entities: oneOf(["tagged", "all"])
    .default("tagged")
    .describe("Which entities keep history: tagged keeps it for entities tagged @history, all for every regular entity without @history off."),
  retention: duration()
    .optional()
    .perRequest()
    .describe(
      "How long versions are kept, like 365d; the current version of a live record is always kept, and without it versions are kept forever. A function of the entity and tenant decides per tenant when pruning.",
    ),
  beforeVersion: hook<HistoryVersionStep | null, undefined>().describe(
    "Runs inside the write's transaction before each version is written, with the entity, the version and the event; it may return a changed step or null to skip the version, and a throw fails the write.",
  ),
  afterVersion: hook<HistoryWrittenVersion, undefined>().describe("Runs after the write committed, with the entity, the stored version and the event; failures are logged."),
  store: provider<HistoryStore>("HistoryStore", ["write", "list", "get", "prune"])
    .optional()
    .describe("Replaces the history tables: it writes, lists, reads and prunes versions, and the build adds no history entities."),
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

/** A step a `beforeVersion` hook returned: the step itself, or just a changed version. */
function stepOf(result: unknown, step: HistoryVersionStep): HistoryVersionStep {
  const value = result as Partial<HistoryVersionStep> & Partial<NewVersion>;
  if (value.version !== undefined && typeof value.version === "object") return { ...step, ...(value as HistoryVersionStep) };
  return { ...step, version: value as NewVersion };
}

/**
 * The `history` native: every write of a chosen entity stores a version of the record in its `<entity>_history`
 * table (or a project's store), in the write's own transaction, with who made it, when and the full record. Off
 * unless `history: {}` (or `QS_HISTORY_ENABLED=true`) is set; it needs `events`.
 */
const historyFeature = defineFeature({
  key: "history",
  docs: { summary: "Every version of the records of chosen entities, kept in a history table written in the same transaction as the change." },
  requires: ["events"],
  options,
  // One read-only system entity per covered entity; nothing when the native is off or a store replaces the tables.
  entities: ({ models, options }) => (options.store ? [] : historyModels(models, options.entities)),
  // The daily history/prune job.
  jobs: "./jobs",
  commands: historyCommands,
  tags: {
    history: {
      on: ["entity", "field"],
      options: ["retention"],
      fieldOptions: [],
      description:
        "`@history` on an entity keeps its versions, `@history retention=7d` sets how long, and `@history off` excludes it; on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them.",
      example: "/** @history retention=90d */\nexport type Contract = {\n  title: string;\n  /** @history off */\n  draftNotes: string;\n};",
    },
  },
  // Project endpoint files at the history routes' paths replace them; the build says so.
  build(ctx) {
    for (const entity of routedEntities(ctx.models, ctx.options.entities)) {
      const paths = historyPaths(entity);
      for (const path of [paths.list, paths.version]) {
        const file = `endpoints${path}/get.ts`;
        if (existsSync(join(ctx.root, file))) ctx.log(`Override: ${file} replaces GET ${path} from history`);
      }
    }
  },
  setup(ctx) {
    const { store, database } = pruneStores(ctx.config.database, ctx.models, ctx.options as never);
    const { beforeVersion, afterVersion } = ctx.options;
    const unsubscribes: (() => void)[] = [];
    for (const entity of coveredEntities(ctx.models, ctx.options.entities)) {
      const name = entity.entityName;
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
            const page = await store.list(name, id, query);
            const anyVersion = page.total > 0 || (query.where.length > 0 && (await store.list(name, id, { where: [], limit: 1, offset: 0 })).total > 0);
            return listAnswer(entity, page, query, hidden, anyVersion);
          },
          { hooks },
        );
        ctx.app.route(
          "GET",
          paths.version,
          async (_repos: Repositories, req: ServiceRequest) => {
            const number = parseVersionNumber(req.params.version);
            const version = await store.get(name, req.params.id!, number);
            if (!version) throw new HttpError(404, `${name} version ${number} not found`);
            return versionResponse(version, hidden);
          },
          { hooks },
        );
      }
      // One listener per covered entity, so writes of other entities never reach the native.
      unsubscribes.push(
        ctx.events.on(
          `${lowerFirst(name)}.written`,
          async (published) => {
            const event = published as WriteEvent;
            let step: HistoryVersionStep = { entity: name, version: versionOf(event, excluded), event };
            for (const fn of beforeVersion) {
              const result = await fn(step, undefined);
              if (result === null) return;
              if (result !== undefined) step = stepOf(result, step);
            }
            const written = (await store.write(step.version, { entity: name })) ?? step.version;
            if (afterVersion.length > 0) {
              const value: HistoryWrittenVersion = { entity: name, version: written, event };
              await afterCommit(() => runAfterHooks(afterVersion, value, undefined));
            }
          },
          { phase: "inTransaction" },
        ),
      );
    }
    setRunningPrune({ store, ...(database ? { database } : {}), targets: pruneTargets(ctx.models, ctx.options as never), logger: ctx.logger });
    ctx.app.onStop(() => {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      setRunningPrune(undefined);
    });
    apis.set(ctx.options, store);
  },
  api: (ctx): HistoryApi => {
    const store = apis.get(ctx.options)!;
    return {
      beforeVersion: (fn) => ctx.addHook("beforeVersion", fn as never),
      afterVersion: (fn) => ctx.addHook("afterVersion", fn as never),
      async versions(entity, id, page = {}) {
        return (await store.list(entity, id, { where: [], limit: page.limit ?? 20, offset: page.offset ?? 0 })).data as HistoryVersion[];
      },
    };
  },
  openapi(doc, { models, options }) {
    return documentHistory(doc, routedEntities(models, options.entities));
  },
});

/** The store each running configuration uses, for its feature API. */
const apis = new WeakMap<object, HistoryStore>();

/** The covered entities that have generated routes, and so history routes. */
function routedEntities(models: Parameters<typeof coveredEntities>[0], coverage: Parameters<typeof coveredEntities>[1]) {
  return coveredEntities(models, coverage).filter((entity) => !entity.internal && !entity.system && !entity.link);
}

export default historyFeature;
export { historyFeature };
export { coveredEntities, excludedFields, historyModel, historyModelKey, historyModels, isCovered, snapshotOf } from "./model.ts";
export { databaseHistoryStore, getVersion, listVersions, writeVersion } from "./store.ts";
export { PRUNE_BATCH, pruneHistory, pruneVersions } from "./prune.ts";
export type { HistoryApi, HistoryRetentionFunction, HistoryStore, HistoryVersionStep, HistoryWrittenVersion } from "./api.ts";
export type { PruneOptions, PruneRun, PruneTarget } from "./prune.ts";
export type { HistoryCoverage, HistoryOperation, HistoryVersion } from "./model.ts";
export type { DatabaseHistoryStore, NewVersion, VersionPage, VersionQuery } from "./store.ts";
