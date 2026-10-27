import {
  boolean,
  hook,
  provider,
  resolveOption,
  runAfterHooks,
  runBeforeHooks,
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
import type { IdempotencyApi, IdempotencyConflict, IdempotencyStep, IdempotencyStore } from "./api.ts";
import { databaseStore, idempotencyKeyEntity, type StoredResponse } from "./store.ts";

const options = object({
  header: string().default("Idempotency-Key").describe("The request header that carries the key."),
  methods: list(oneOf(["POST", "PUT", "PATCH", "DELETE"]))
    .default(["POST"])
    .describe("The methods whose routes honor keys; @idempotent turns a route on for any method."),
  required: boolean().default(false).perRequest().describe("Rejects requests without the header with 400 on the routes that honor keys; a function of the request decides per request."),
  ttl: duration().default("24h").perRequest().describe("How long a stored response is replayed for its key; a function of the request decides per request."),
  maxResponseSize: size().default("1MB").describe("The largest response body stored for replays; larger ones release the key."),
  scope: string()
    .optional()
    .perRequest()
    .describe("Replaces the user part of a key's scope: a function of the request, its user and tenant returning a text, like the tenant id with the user id."),
  beforeReplay: hook<IdempotencyStep | false, undefined>().describe("Runs before a stored response is replayed with the request and the record; returning false deletes the record and runs the request again."),
  afterStore: hook<IdempotencyStep, undefined>().describe("Runs after a response was stored for a key, with the request and the record."),
  onConflict: hook<IdempotencyConflict, undefined>().describe("Runs when a key is refused, with the request and the kind: reused for another request, inUse for one in progress."),
  store: provider<IdempotencyStore>("IdempotencyStore", ["begin", "complete", "release", "cleanup"])
    .optional()
    .describe("Replaces where keys are kept; without the IdempotencyKey entity in the build."),
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
  // A project store keeps the keys elsewhere, so the build adds no entity for them.
  entities: ({ options }) => (options.store ? [] : [idempotencyKeyEntity()]),
  tags: {
    idempotent: {
      on: ["entity", "endpoint"],
      options: ["required", "ttl"],
      description: "`@idempotent` honors keys on an endpoint whatever its method, or on an entity's create route; `required` and `ttl` override the options there, and `@idempotent off` ignores keys.",
      example: "/** @idempotent required=true ttl=7d */\nexport type Order = { total: number };",
    },
  },
  setup(ctx) {
    const configured = ctx.options.store as IdempotencyStore | undefined;
    const model = ctx.models.find((candidate) => candidate.key === "IdempotencyKey" && candidate.system);
    if (!configured && !model) throw new Error("The idempotency native needs the IdempotencyKey entity; run quickservicets build after enabling it");
    const store: IdempotencyStore = configured ?? databaseStore(ctx.config.database, model!, ctx.logger);
    const { beforeReplay, afterStore, onConflict } = ctx.options;
    const maxBytes = parseSize(ctx.options.maxResponseSize) ?? 1_048_576;
    const header = ctx.options.header;
    // Whether a route honors keys, decided once per method and route pattern.
    const decisions = new Map<string, { on: boolean; required: boolean | ((ctx: never) => unknown); ttl: string | ((ctx: never) => unknown) }>();
    const decide = (req: ServiceRequest) => {
      const routeKey = `${req.method} ${req.route}`;
      let decision = decisions.get(routeKey);
      if (!decision) {
        const target = idempotencyFeature.optionsFor(req);
        // A tag on an endpoint applies whatever its method; on an entity, to its create route.
        const onEndpoint = tagsOf({ method: req.method, path: req.route })?.idempotent !== undefined;
        const tagged = target.on === true && (onEndpoint || req.method === "POST");
        const on = target.on === false ? false : tagged || (ctx.options.methods as string[]).includes(req.method);
        decision = { on, required: target.required, ttl: target.ttl };
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
          if (await resolveOption(decision.required as boolean, { req })) throw new HttpError(400, `${header} header is required`);
          return next();
        }
        if (!KEY.test(key)) throw new HttpError(400, `Invalid ${header} header`);
        const ttlMs = parseDuration(await resolveOption(decision.ttl as string, { req })) ?? 86_400_000;
        const user = ctx.options.scope !== undefined ? String(await resolveOption(ctx.options.scope, { req })) : userOf(req);
        const scope = scopeOf(key, req, user);
        const fingerprint = await fingerprintOf(req);
        let begun = await store.begin({ scope, fingerprint, ttlMs });
        if (begun.kind === "replay" && beforeReplay.length > 0 && (await runBeforeHooks(beforeReplay, { req, record: begun.record } as IdempotencyStep | false, undefined)) === false) {
          // The hook refused the replay: the request runs again under a new record.
          await store.release(begun.record);
          begun = await store.begin({ scope, fingerprint, ttlMs });
        }
        if (begun.kind === "reused" || begun.kind === "inUse") {
          if (onConflict.length > 0) await runAfterHooks(onConflict, { req, kind: begun.kind }, undefined);
          if (begun.kind === "reused") throw new HttpError(422, `${header} was used with a different request`, { code: "IDEMPOTENCY_KEY_REUSED" });
          throw new HttpError(409, `A request with this ${header} is in progress`, { code: "IDEMPOTENCY_KEY_IN_USE", headers: { "retry-after": "1" } });
        }
        if (begun.kind === "replay") return replayed(begun.record.response!);
        const record = begun.record;
        const keep = async (stored: StoredResponse) => {
          await store.complete(record, stored, ttlMs);
          if (afterStore.length > 0) await runAfterHooks(afterStore, { req, record: { ...record, status: "done", response: stored } }, undefined);
        };
        let response: Response;
        try {
          const result = await next();
          response = toResponse(result, res as never, (res as ServiceResponse & { defaultStatus?: number }).defaultStatus);
        } catch (error) {
          // A 4xx error is the answer to this request: stored and replayed. Anything else lets a retry run again.
          const stored = error instanceof HttpError && error.status < 500 ? await storable(errorResponse(error), maxBytes) : undefined;
          if (stored) await keep(stored);
          else await store.release(record);
          throw error;
        }
        const stored = await storable(response, maxBytes);
        if (stored) await keep(stored);
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
  api: (ctx): IdempotencyApi => ({ addHook: ctx.addHook as IdempotencyApi["addHook"] }),
});

/** The JSON body of an `HttpError`, as the client receives it. */
function errorResponse(error: HttpError): Response {
  const body: { error: { code: string; message: string; details?: unknown } } = { error: { code: error.code, message: error.responseMessage ?? error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return new Response(JSON.stringify(body), { status: error.status, headers: { "content-type": "application/json", ...(error.headers ?? {}) } });
}

export default idempotencyFeature;
export { idempotencyFeature };
export { databaseStore as idempotencyDatabaseStore, idempotencyKeyEntity } from "./store.ts";
export type { BeginResult, IdempotencyRecord, StoredResponse } from "./store.ts";
export type { IdempotencyApi, IdempotencyConflict, IdempotencyStep, IdempotencyStore } from "./api.ts";
