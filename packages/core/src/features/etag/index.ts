import { defineFeature, entityRoutePath, storedRecordOf, trackStoredRecords, type HandlerMiddleware, type OpenApiDoc } from "../public.ts";
import { etagOf, noneMatch } from "./tags.ts";

/** The generated routes whose responses carry the written or read record's tag. */
const TAGGED_METHODS = new Set(["GET", "POST", "PATCH", "PUT"]);

/**
 * The `etag` native: every record read or written through the generated routes gets a strong entity tag in the `ETag`
 * header, and a read whose `If-None-Match` lists the current tag answers 304, so clients can cache and later detect
 * concurrent edits. Off unless `etag: {}` (or `QS_ETAG_ENABLED=true`) is set.
 */
const etagFeature = defineFeature({
  key: "etag",
  docs: { summary: "Entity tags on record reads and writes, with 304 answers to conditional reads." },
  setup(ctx) {
    trackStoredRecords(true);
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
    ctx.app.onStop(() => trackStoredRecords(false));
  },
  openapi(doc, { models }) {
    return documentTags(doc, models);
  },
});

const ETAG_HEADER = { ETag: { description: "The record's strong entity tag.", schema: { type: "string" } } };

/** Documents the `ETag` header, `If-None-Match` and 304 on the generated routes of every entity. */
function documentTags(doc: OpenApiDoc, models: readonly { internal?: boolean; key: string; entityName: string; name: string; schema: string | null }[]): OpenApiDoc {
  for (const model of models) {
    if (model.internal) continue;
    const collection = entityRoutePath(model as never);
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
  }
  return doc;
}

export default etagFeature;
export { etagFeature };
export { etagOf, noneMatch } from "./tags.ts";
