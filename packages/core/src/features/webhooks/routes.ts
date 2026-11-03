import { HttpError, requireRole, requireUser, safeLog, type FeatureSetupContext, type OpenApiDoc, type Repositories, type ServiceRequest, type ServiceResponse } from "../public.ts";
import type { CreateSubscriptionInput, WebhookSubscriptions } from "./subscriptions.ts";

/** The routes of subscriptions, as `routes` resolves. */
export interface RouteSettings {
  enabled: boolean;
  path: string;
  roles: readonly string[];
}

/** The line logged once when the routes are on but `auth` is not. */
export const ROUTES_NEED_AUTH = "webhooks.routes need authentication; enable auth or manage subscriptions with webhooks.subscriptions";

/** The caller of a management route: a user holding one of the roles (any user with an empty list). */
export function callerOf(req: ServiceRequest, roles: readonly string[]): { id: string } {
  return roles.length === 0 ? requireUser(req) : requireRole(req, ...roles);
}

/** A subscription id of another tenant, or of none, answers 404 without naming the id. */
async function scoped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && error.status === 404 && error.message.startsWith("Webhook subscription ")) throw new HttpError(404, "Webhook subscription not found");
    throw error;
  }
}

const integerOf = (value: unknown, fallback: number, min: number, max: number, name: string): number => {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new HttpError(400, "Invalid query", { details: [{ field: name, message: `Must be an integer from ${min} to ${max}` }] });
  return number;
};

const booleanOf = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(400, "Invalid query", { details: [{ field: name, message: "Must be true or false" }] });
};

const bodyOf = async (req: ServiceRequest): Promise<Record<string, unknown>> => {
  const body = await req.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Invalid body", { details: [{ field: "body", message: "Must be a JSON object" }] });
  return body as Record<string, unknown>;
};

const pick = (body: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

/** Registers the subscription routes under `settings.path`. */
export function registerRoutes(ctx: Pick<FeatureSetupContext, "app">, settings: RouteSettings, subscriptions: () => WebhookSubscriptions): void {
  const base = settings.path.replace(/\/+$/, "");
  const one = `${base}/[id]`;
  const route = (method: string, path: string, handler: (req: ServiceRequest, res: ServiceResponse) => unknown) =>
    ctx.app.route(method, path, async (_repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
      callerOf(req, settings.roles);
      return handler(req, res);
    });
  route("GET", base, async (req) => {
    const limit = integerOf(req.query.get("limit") ?? undefined, 20, 1, 100, "limit");
    const offset = integerOf(req.query.get("offset") ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const enabled = booleanOf(req.query.get("enabled") ?? undefined, "enabled");
    return subscriptions().list({ limit, offset, ...(enabled !== undefined ? { enabled } : {}) });
  });
  route("POST", base, async (req, res) => {
    const user = callerOf(req, settings.roles);
    const body = await bodyOf(req);
    const created = await subscriptions().create({ ...(pick(body, ["url", "events", "description", "headers"]) as unknown as CreateSubscriptionInput), createdBy: String(user.id) });
    res.status(201);
    return created;
  });
  route("GET", one, (req) => scoped(() => subscriptions().get(req.params.id!)));
  route("PATCH", one, async (req) => scoped(async () => subscriptions().update(req.params.id!, pick(await bodyOf(req), ["url", "events", "description", "headers", "enabled"]) as never)));
  route("DELETE", one, async (req, res) => {
    await scoped(() => subscriptions().delete(req.params.id!));
    res.status(204);
    return undefined;
  });
  route("POST", `${one}/rotate-secret`, (req) => scoped(() => subscriptions().rotateSecret(req.params.id!)));
}

/** Logs that the routes are on but cannot be served without `auth`; the setup calls it once. */
export function warnRoutesNeedAuth(logger: FeatureSetupContext["logger"]): void {
  safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: ROUTES_NEED_AUTH });
}

const ERROR_SCHEMA = {
  type: "object",
  required: ["code", "message"],
  properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
};
const error = (description: string) => ({ description, content: { "application/json": { schema: ERROR_SCHEMA } } });
const json = (description: string, schema: unknown) => ({ description, content: { "application/json": { schema } } });

/** Documents the subscription routes, under the `webhooks` tag, as needing a user with one of the roles. */
export function documentRoutes(doc: OpenApiDoc, settings: RouteSettings): OpenApiDoc {
  const base = settings.path.replace(/\/+$/, "") || "/";
  const subscription = { $ref: "#/components/schemas/WebhookSubscription" };
  doc.components ??= {};
  const schemas = ((doc.components as Record<string, unknown>).schemas ??= {}) as Record<string, unknown>;
  schemas.WebhookSubscription = {
    type: "object",
    required: ["id", "url", "events", "enabled", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
      description: { type: "string", nullable: true },
      enabled: { type: "boolean" },
      disabledReason: { type: "string", nullable: true },
      failingSince: { type: "string", format: "date-time", nullable: true },
      previousSecretExpiresAt: { type: "string", format: "date-time", nullable: true },
      headers: { type: "object", additionalProperties: { type: "string" }, nullable: true },
      tenant: { type: "string", nullable: true },
      createdBy: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  };
  const input = (required: string[]) => ({
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties: {
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" }, minItems: 1 },
      description: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      ...(required.length === 0 ? { enabled: { type: "boolean" } } : {}),
    },
  });
  const auth = { ...(settings.roles.length > 0 ? { roles: [...settings.roles] } : {}) };
  const notes = settings.roles.length > 0 ? `Requires one of the roles: ${settings.roles.join(", ")}.` : "Requires a signed-in user.";
  const operation = (summary: string, operationId: string, responses: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    tags: ["webhooks"],
    operationId,
    summary,
    description: notes,
    "x-auth": auth,
    ...extra,
    responses: { ...responses, "401": error("Authentication required"), "403": error("Not allowed") },
  });
  const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
  doc.paths[base] = {
    ...(doc.paths[base] ?? {}),
    get: operation("The webhook subscriptions, newest first", "listWebhookSubscriptions", {
      "200": json("A page of subscriptions", { type: "object", required: ["data", "total", "limit", "offset"], properties: { data: { type: "array", items: subscription }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } } }),
      "400": error("Invalid query"),
    }, {
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        { name: "enabled", in: "query", schema: { type: "boolean" } },
      ],
    }),
    post: operation("Creates a webhook subscription, answering its secret once", "createWebhookSubscription", {
      "201": json("The subscription with its secret", { allOf: [subscription, { type: "object", required: ["secret"], properties: { secret: { type: "string" } } }] }),
      "400": error("Invalid body"),
    }, { requestBody: { required: true, content: { "application/json": { schema: input(["url", "events"]) } } } }),
  };
  doc.paths[`${base}/{id}`] = {
    get: operation("One webhook subscription", "readWebhookSubscription", { "200": json("The subscription", subscription), "404": error("Webhook subscription not found") }, { parameters: [id] }),
    patch: operation("Changes a webhook subscription", "updateWebhookSubscription", { "200": json("The subscription", subscription), "400": error("Invalid body"), "404": error("Webhook subscription not found") }, {
      parameters: [id],
      requestBody: { required: true, content: { "application/json": { schema: input([]) } } },
    }),
    delete: operation("Deletes a webhook subscription", "deleteWebhookSubscription", { "204": { description: "Deleted" }, "404": error("Webhook subscription not found") }, { parameters: [id] }),
  };
  doc.paths[`${base}/{id}/rotate-secret`] = {
    post: operation("Replaces the secret, keeping the old one valid for 24 hours", "rotateWebhookSecret", {
      "200": json("The new secret", { type: "object", required: ["secret", "previousSecretExpiresAt"], properties: { secret: { type: "string" }, previousSecretExpiresAt: { type: "string", format: "date-time" } } }),
      "404": error("Webhook subscription not found"),
    }, { parameters: [id] }),
  };
  return doc;
}
