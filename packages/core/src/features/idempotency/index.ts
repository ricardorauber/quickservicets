import {
  boolean,
  defineFeature,
  duration,
  HttpError,
  list,
  object,
  oneOf,
  parseDuration,
  parseSize,
  safeLog,
  size,
  string,
  tagsOf,
  toResponse,
  type HandlerMiddleware,
  type ServiceRequest,
  type ServiceResponse,
} from "../public.ts";
import { databaseStore, idempotencyKeyEntity, type DatabaseIdempotencyStore, type StoredResponse } from "./store.ts";

const options = object({
  header: string().default("Idempotency-Key").describe("The request header that carries the key."),
  methods: list(oneOf(["POST", "PUT", "PATCH", "DELETE"]))
    .default(["POST"])
    .describe("The methods whose routes honor keys; @idempotent turns a route on for any method."),
  required: boolean().default(false).describe("Rejects requests without the header with 400 on the routes that honor keys."),
  ttl: duration().default("24h").describe("How long a stored response is replayed for its key."),
  maxResponseSize: size().default("1MB").describe("The largest response body stored for replays; larger ones release the key."),
});

/** How often every process deletes the expired keys. */
export const CLEANUP_INTERVAL = 3_600_000;

/** The headers a stored response keeps. */
const KEPT_HEADERS = ["content-type", "location", "etag"];

/** Keys are 1 to 255 visible ASCII characters. */
const KEY = /^[\x21-\x7e]{1,255}$/;

const sha256 = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** The fingerprint of a request: the method, path, sorted query string and raw body bytes. */
export async function fingerprintOf(req: ServiceRequest): Promise<string> {
  const url = new URL(req.raw.url);
  const query = [...url.searchParams].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const head = new TextEncoder().encode(`${req.method}\n${url.pathname}\n${new URLSearchParams(query).toString()}\n`);
  const body = new Uint8Array(await req.raw.clone().arrayBuffer());
  return new Bun.CryptoHasher("sha256").update(head).update(body).digest("hex");
}

/** The scope of a key: the key with the method, the route pattern and the user, hashed. */
export const scopeOf = (key: string, req: ServiceRequest, user: string): string => sha256(JSON.stringify([key, req.method, req.route, user]));

const userOf = (req: ServiceRequest) => String((req.user as { id?: unknown } | undefined)?.id ?? "anonymous");

/** The response a client receives on a replay. */
function replayed(stored: StoredResponse): Response {
  const headers = new Headers(stored.headers);
  headers.set("idempotent-replayed", "true");
  return new Response(stored.body === "" ? null : stored.body, { status: stored.status, headers });
}

/** The parts of a response kept for replays, or undefined when it must not be stored. */
async function storable(response: Response, maxBytes: number): Promise<StoredResponse | undefined> {
  const status = response.status;
  if (!((status >= 200 && status < 300) || (status >= 400 && status < 500))) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (response.body !== null && !/^(application\/([\w.+-]*\+)?json|text\/)/.test(type)) return undefined;
  const body = response.body === null ? "" : await response.clone().text();
  if (Buffer.byteLength(body) > maxBytes) return undefined;
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status, headers, body };
}

/**
 * The `idempotency` native: a request repeated with the same `Idempotency-Key` gets the first response again, without
 * running the hooks or the handler, so clients can retry a `POST` safely. Off unless `idempotency: {}` (or
 * `QS_IDEMPOTENCY_ENABLED=true`) is set.
 */
const idempotencyFeature = defineFeature({
  key: "idempotency",
  docs: { summary: "Idempotency keys: a request repeated with the same Idempotency-Key gets the first response again without running twice." },
  options,
  entities: () => [idempotencyKeyEntity()],
  tags: {
    idempotent: {
      on: ["entity", "endpoint"],
      options: ["required", "ttl"],
      description: "`@idempotent` honors keys on an endpoint whatever its method, or on an entity's create route; `required` and `ttl` override the options there, and `@idempotent off` ignores keys.",
      example: "/** @idempotent required=true ttl=7d */\nexport type Order = { total: number };",
    },
  },
  setup(ctx) {
    const model = ctx.models.find((candidate) => candidate.key === "IdempotencyKey" && candidate.system);
    if (!model) throw new Error("The idempotency native needs the IdempotencyKey entity; run quickservice build after enabling it");
    const store: DatabaseIdempotencyStore = databaseStore(ctx.config.database, model, ctx.logger);
    const maxBytes = parseSize(ctx.options.maxResponseSize) ?? 1_048_576;
    const header = ctx.options.header;
    // Whether a route honors keys, decided once per method and route pattern.
    const decisions = new Map<string, { on: boolean; required: boolean; ttlMs: number }>();
    const decide = (req: ServiceRequest) => {
      const routeKey = `${req.method} ${req.route}`;
      let decision = decisions.get(routeKey);
      if (!decision) {
        const target = idempotencyFeature.optionsFor(req);
        // A tag on an endpoint applies whatever its method; on an entity, to its create route.
        const onEndpoint = tagsOf({ method: req.method, path: req.route })?.idempotent !== undefined;
        const tagged = target.on === true && (onEndpoint || req.method === "POST");
        const on = target.on === false ? false : tagged || (ctx.options.methods as string[]).includes(req.method);
        decision = { on, required: target.required, ttlMs: parseDuration(target.ttl) ?? 86_400_000 };
        decisions.set(routeKey, decision);
      }
      return decision;
    };
    const middleware: HandlerMiddleware = {
      stage: "handler",
      // Inside the project's handler middlewares, so the scope sees the user they set.
      order: 1000,
      async run(req, res, next) {
        const decision = decide(req);
        if (!decision.on) return next();
        const key = req.headers.get(header);
        if (key === null) {
          if (decision.required) throw new HttpError(400, `${header} header is required`);
          return next();
        }
        if (!KEY.test(key)) throw new HttpError(400, `Invalid ${header} header`);
        const scope = scopeOf(key, req, userOf(req));
        const begun = await store.begin({ scope, fingerprint: await fingerprintOf(req), ttlMs: decision.ttlMs });
        if (begun.kind === "reused") throw new HttpError(422, `${header} was used with a different request`, { code: "IDEMPOTENCY_KEY_REUSED" });
        if (begun.kind === "inUse") throw new HttpError(409, `A request with this ${header} is in progress`, { code: "IDEMPOTENCY_KEY_IN_USE", headers: { "retry-after": "1" } });
        if (begun.kind === "replay") return replayed(begun.record.response!);
        const record = begun.record;
        let response: Response;
        try {
          const result = await next();
          response = toResponse(result, res as never, (res as ServiceResponse & { defaultStatus?: number }).defaultStatus);
        } catch (error) {
          // A 4xx error is the answer to this request: stored and replayed. Anything else lets a retry run again.
          const stored = error instanceof HttpError && error.status < 500 ? await storable(errorResponse(error), maxBytes) : undefined;
          if (stored) await store.complete(record, stored, decision.ttlMs);
          else await store.release(record);
          throw error;
        }
        const stored = await storable(response, maxBytes);
        if (stored) await store.complete(record, stored, decision.ttlMs);
        else await store.release(record);
        return response;
      },
    };
    ctx.app.use(middleware);
    let cleanup: ReturnType<typeof setInterval> | undefined;
    const clean = () =>
      void store.cleanup().catch((error: unknown) => safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "idempotency.cleanup.failed", error: { message: (error as Error)?.message ?? String(error) } }));
    ctx.app.onStart(() => {
      clean();
      cleanup = setInterval(clean, CLEANUP_INTERVAL);
    });
    ctx.app.onStop(() => clearInterval(cleanup));
  },
});

/** The JSON body of an `HttpError`, as the client receives it. */
function errorResponse(error: HttpError): Response {
  const body: { error: { code: string; message: string; details?: unknown } } = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return new Response(JSON.stringify(body), { status: error.status, headers: { "content-type": "application/json", ...(error.headers ?? {}) } });
}

export default idempotencyFeature;
export { idempotencyFeature };
export { databaseStore as idempotencyDatabaseStore, idempotencyKeyEntity } from "./store.ts";
export type { BeginResult, IdempotencyRecord, StoredResponse } from "./store.ts";
