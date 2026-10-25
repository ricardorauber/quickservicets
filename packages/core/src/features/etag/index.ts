import { boolean, defineFeature, entityRoutePath, HttpError, object, setWriteCondition, storedRecordOf, trackStoredRecords, type EntityModel, type HandlerMiddleware, type OpenApiDoc } from "../public.ts";
import { etagOf, noneMatch } from "./tags.ts";

/** The generated routes whose responses carry the written or read record's tag. */
const TAGGED_METHODS = new Set(["GET", "POST", "PATCH", "PUT"]);

/**
 * The `etag` native: every record read or written through the generated routes gets a strong entity tag in the `ETag`
 * header, and a read whose `If-None-Match` lists the current tag answers 304, so clients can cache and later detect
 * concurrent edits. Off unless `etag: {}` (or `QS_ETAG_ENABLED=true`) is set.
 */
const options = object({
  required: boolean().default(false).describe("Rejects PATCH, PUT and DELETE requests of the generated routes without If-Match with 428."),
});

const etagFeature = defineFeature({
  key: "etag",
  docs: { summary: "Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes." },
  options,
  tags: {
    etag: {
      on: ["entity"],
      options: ["required"],
      description: "`@etag required=true` requires If-Match on the entity's PATCH, PUT and DELETE routes.",
      example: "/** @etag required=true */\nexport type Invoice = { total: number };",
    },
  },
  setup(ctx) {
    trackStoredRecords(true);
    // The generated write routes check If-Match atomically in the repository; a missing one is refused when required.
    setWriteCondition((req, entity) => {
      const header = req.headers.get("if-match");
      if (header === null) {
        if (etagFeature.optionsFor(entity).required) throw new HttpError(428, "If-Match header is required");
        return undefined;
      }
      return { ifMatch: header };
    });
    ctx.app.configureServer({ entityTags: { tag: etagOf, noneMatch } });
    const middleware: HandlerMiddleware = {
      stage: "handler",
      // Inside the other handler middlewares, right around the route's hooks and handler.
      order: 2000,
      async run(req, res, next) {
        const result = await next();
        if (!TAGGED_METHODS.has(req.method) || result instanceof Response) return result;
        const stored = storedRecordOf(req);
        if (!stored) return result;
        const tag = etagOf(stored.record);
        res.header("etag", tag);
        if (req.method !== "GET") return result;
        const controls = res as typeof res & { headers?: Headers };
        if (!controls.headers?.has("cache-control")) res.header("cache-control", "private, no-cache");
        // The read's pre-hooks already ran, so a refused request never gets here.
        if (noneMatch(req.headers.get("if-none-match"), tag)) return new Response(null, { status: 304, headers: controls.headers });
        return result;
      },
    };
    ctx.app.use(middleware);
    ctx.app.onStop(() => {
      trackStoredRecords(false);
      setWriteCondition(undefined);
    });
  },
  openapi(doc, { models, options }) {
    return documentTags(doc, models, (model) => options.required || (model as EntityModel).tags?.etag?.options.required === true);
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
