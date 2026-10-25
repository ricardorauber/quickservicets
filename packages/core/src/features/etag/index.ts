import {
  boolean,
  defineFeature,
  entityRoutePath,
  hook,
  HttpError,
  object,
  provider,
  resolveOption,
  runAfterHooks,
  safeLog,
  setWriteCondition,
  storedRecordOf,
  trackStoredRecords,
  type EntityModel,
  type HandlerMiddleware,
  type OpenApiDoc,
  type StoredRecord,
} from "../public.ts";
import type { EntityTagger, NotModified, PreconditionFailure } from "./api.ts";
import { etagOf, noneMatch } from "./tags.ts";

/** The generated routes whose responses carry the written or read record's tag. */
const TAGGED_METHODS = new Set(["GET", "POST", "PATCH", "PUT"]);

const options = object({
  required: boolean()
    .default(false)
    .perRequest()
    .describe("Rejects PATCH, PUT and DELETE requests of the generated routes without If-Match with 428; a function of the request decides per request."),
  onPreconditionFailed: hook<PreconditionFailure, undefined>().describe(
    "Runs when a conditional write is refused, with the request, entity, id, expected and current tags; a Response it returns replaces the 412.",
  ),
  onNotModified: hook<NotModified, undefined>().describe("Runs for each 304 answer, with the request, the entity and the id."),
  tagger: provider<EntityTagger>("EntityTagger", ["tag"])
    .optional()
    .describe("Replaces etagOf for the native's routes: its tag method gets the stored record and the entity and returns a strong tag."),
});

/** A tag text quoted when it is not. */
const quoted = (tag: string) => (/^".*"$/.test(tag) ? tag : `"${tag}"`);

/**
 * The `etag` native: every record read or written through the generated routes gets a strong entity tag in the `ETag`
 * header, a read whose `If-None-Match` lists the current tag answers 304, and a write whose `If-Match` lists an old tag
 * answers 412, so clients can cache and never overwrite a newer version. Off unless `etag: {}` (or
 * `QS_ETAG_ENABLED=true`) is set.
 */
const etagFeature = defineFeature({
  key: "etag",
  docs: { summary: "Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes." },
  options,
  tags: {
    etag: {
      on: ["entity"],
      options: ["required"],
      description: "`@etag required=true` requires If-Match on the entity's PATCH, PUT and DELETE routes, `@etag required=false` exempts it, and `@etag off` removes tags and conditions from its routes.",
      example: "/** @etag required=true */\nexport type Invoice = { total: number };",
    },
  },
  setup(ctx) {
    const tagger = ctx.options.tagger as EntityTagger | undefined;
    const tagOf = (record: object, entity?: EntityModel) => (tagger ? quoted(tagger.tag(record as StoredRecord, entity)) : etagOf(record));
    const enabledFor = (entity: EntityModel) => etagFeature.optionsFor(entity).on !== false;
    trackStoredRecords(true);
    // The generated write routes check If-Match atomically in the repository; a missing one is refused when required.
    const writing = new WeakMap<object, EntityModel>();
    setWriteCondition(async (req, entity) => {
      if (!enabledFor(entity)) return undefined;
      writing.set(req, entity);
      const header = req.headers.get("if-match");
      if (header === null) {
        if (await resolveOption(etagFeature.optionsFor(entity).required, { req })) throw new HttpError(428, "If-Match header is required");
        return undefined;
      }
      return { ifMatch: header, ...(tagger ? { tagOf: (record: StoredRecord) => tagOf(record, entity) } : {}) };
    });
    ctx.app.configureServer({ entityTags: { tag: (record) => tagOf(record), noneMatch } });
    const { onPreconditionFailed, onNotModified } = ctx.options;
    const notModified = async (value: NotModified) => {
      if (onNotModified.length > 0) await runAfterHooks(onNotModified, value, undefined);
    };
    const middleware: HandlerMiddleware = {
      stage: "handler",
      // Inside the other handler middlewares, right around the route's hooks and handler.
      order: 2000,
      async run(req, res, next) {
        let result: unknown;
        try {
          result = await next();
        } catch (error) {
          const replaced = error instanceof HttpError && error.code === "PRECONDITION_FAILED" && onPreconditionFailed.length > 0 ? await preconditionResponse(req, error) : undefined;
          if (replaced) return replaced;
          throw error;
        }
        const controls = res as typeof res & { headers?: Headers; notModified?: boolean };
        if (controls.notModified) await notModified({ req, entity: undefined, id: req.params.id });
        if (!TAGGED_METHODS.has(req.method) || result instanceof Response) return result as never;
        const stored = storedRecordOf(req);
        if (!stored || !enabledFor(stored.entity)) return result as never;
        const tag = tagOf(stored.record, stored.entity);
        res.header("etag", tag);
        if (req.method !== "GET") return result as never;
        if (!controls.headers?.has("cache-control")) res.header("cache-control", "private, no-cache");
        // The read's pre-hooks already ran, so a refused request never gets here.
        if (noneMatch(req.headers.get("if-none-match"), tag)) {
          await notModified({ req, entity: stored.entity.entityName, id: stored.record.id });
          return new Response(null, { status: 304, headers: controls.headers });
        }
        return result as never;
      },
    };
    /** The first Response an onPreconditionFailed hook returns, replacing the 412. */
    const preconditionResponse = async (req: Parameters<HandlerMiddleware["run"]>[0], error: HttpError): Promise<Response | undefined> => {
      const value: PreconditionFailure = {
        req,
        entity: writing.get(req)?.entityName,
        id: req.params.id,
        expected: req.headers.get("if-match") ?? "",
        current: error.headers?.etag,
      };
      for (const fn of onPreconditionFailed) {
        try {
          const response = await fn(value, undefined);
          if (response instanceof Response) return response;
        } catch (failure) {
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "feature.hook.failed", feature: "etag", hook: "onPreconditionFailed", error: { message: (failure as Error)?.message ?? String(failure) } });
        }
      }
      return undefined;
    };
    ctx.app.use(middleware);
    ctx.app.onStop(() => {
      trackStoredRecords(false);
      setWriteCondition(undefined);
    });
  },
  openapi(doc, { models, options }) {
    return documentTags(doc, models, (model) => options.required === true || (model as EntityModel).tags?.etag?.options.required === true);
  },
});

const ETAG_HEADER = { ETag: { description: "The record's strong entity tag.", schema: { type: "string" } } };

/** Documents the `ETag` header, `If-None-Match` and 304 on the generated routes of every entity. */
function documentTags(doc: OpenApiDoc, models: readonly EntityModel[], required: (model: EntityModel) => boolean): OpenApiDoc {
  for (const model of models) {
    if (model.internal) continue;
    const collection = entityRoutePath(model);
    type Operation = { parameters?: unknown[]; responses?: Record<string, { description?: string; headers?: Record<string, unknown> }> };
    const item = doc.paths[`${collection}/{id}`] as Record<string, Operation> | undefined;
    const list = doc.paths[collection] as typeof item;
    const withHeader = (operation: Operation | undefined, status: string) => {
      const response = operation?.responses?.[status];
      if (response) response.headers = { ...(response.headers ?? {}), ...ETAG_HEADER };
    };
    const read = item?.get;
    if (read) {
      withHeader(read, "200");
      read.parameters = [...(read.parameters ?? []), { name: "If-None-Match", in: "header", required: false, description: "Answers 304 when it lists the record's current tag.", schema: { type: "string" } }];
      read.responses = { ...(read.responses ?? {}), "304": { description: "Not modified: the record still has the tag of If-None-Match." } };
    }
    withHeader(list?.post, "201");
    withHeader(item?.patch, "200");
    withHeader(item?.put, "200");
    const mustMatch = required(model);
    for (const write of [item?.patch, item?.put, item?.delete]) {
      if (!write) continue;
      write.parameters = [
        ...(write.parameters ?? []),
        { name: "If-Match", in: "header", required: mustMatch, description: "Writes only when it lists the record's current tag, or is *.", schema: { type: "string" } },
      ];
      write.responses = {
        ...(write.responses ?? {}),
        "412": { description: "Precondition failed: the record was changed by another request; the ETag header has its current tag." },
        ...(mustMatch ? { "428": { description: "Precondition required: the If-Match header is missing." } } : {}),
      };
    }
  }
  return doc;
}

export default etagFeature;
export { etagFeature };
export { etagOf, noneMatch } from "./tags.ts";
export type { EntityTagger, NotModified, PreconditionFailure } from "./api.ts";
