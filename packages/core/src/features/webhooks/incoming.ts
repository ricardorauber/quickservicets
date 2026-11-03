import { createHmac, timingSafeEqual } from "node:crypto";
import {
  bodyPolicyOf,
  HttpError,
  isSecretReference,
  parseDuration,
  parseSize,
  readBodyBytes,
  safeLog,
  secretValue,
  setBodyPolicy,
  type Endpoint,
  type JobLogger,
  type Logger,
  type Repositories,
  type SecretReference,
  type ServiceRequest,
  type ServiceResponse,
} from "../public.ts";
import { verifyWebhook } from "./signing.ts";
import { webhookClock } from "./state.ts";

/** Why a signature was refused. */
export type WebhookRejection = "missing" | "malformed" | "mismatch" | "expired";

/** What a verifier found: a valid signature with the delivery's id and event type when known, or why it was refused. */
export type WebhookVerification = { ok: true; deliveryId?: string; eventType?: string } | { ok: false; reason: WebhookRejection };

/** What a verifier checks. */
export interface WebhookVerifyInput {
  headers: Headers;
  /** The body exactly as it arrived. */
  rawBody: Uint8Array;
  req: ServiceRequest;
  /** The request's tenant id, when tenancy resolved one. */
  tenant?: string;
  /** The route's timestamp tolerance, in milliseconds. */
  tolerance: number;
  /** The current time, in milliseconds. */
  now: number;
}

/** Checks the signature of an incoming webhook. */
export interface WebhookVerifier {
  /** The verifier's name, shown in the API docs (`x-webhook`). */
  readonly name: string;
  verify(input: WebhookVerifyInput): WebhookVerification | Promise<WebhookVerification>;
}

/** A secret of a verifier: a text, a secret reference (`{tenant}` resolved for the request), or a function of the request. */
export type WebhookSecretValue = string | SecretReference | ((ctx: { req: ServiceRequest; tenant?: string }) => string | Promise<string>);

/** One secret, or a list of them during a rotation: a signature by any one is accepted. */
export type WebhookSecret = WebhookSecretValue | readonly WebhookSecretValue[];

/** What `handle` receives besides the event. */
export interface WebhookHandleContext {
  /** The request; undefined when `handle` runs in the queue (`async: true`). */
  req: ServiceRequest | undefined;
  repos: Repositories;
  /** The body exactly as it arrived; undefined when `handle` runs in the queue. */
  rawBody: Uint8Array | undefined;
  headers: Headers;
  /** The sender's id of this delivery, when the verifier knows it. */
  deliveryId: string | undefined;
  /** The sender's event name, when the verifier knows it. */
  eventType: string | undefined;
  log: JobLogger;
}

/** What `defineWebhook` takes. */
export interface WebhookOptions<Event = unknown> {
  /** Checks the signature on the raw body before anything else runs: a verifier, or the name of a registered one. */
  verify: WebhookVerifier | string;
  /** Handles the verified event; resolving answers 200 `{ "received": true }`, an `HttpError` answers itself. */
  handle(event: Event, ctx: WebhookHandleContext): unknown;
  /** Runs `handle` in the `webhooks/incoming` queue and answers 202 at once (default false). */
  async?: boolean;
}

const WEBHOOK_MARKER = Symbol.for("quickservicets.webhook");

/** An incoming webhook, as `webhook.ts` files default-export it. */
export interface WebhookDefinition<Event = unknown> extends WebhookOptions<Event> {
  readonly [WEBHOOK_MARKER]: true;
}

/**
 * Declares an incoming webhook: the default export of a `webhook.ts` endpoint file, served as `POST` at its folder's
 * path. `verify` checks the signature on the raw body before hooks or `handle` run.
 */
export function defineWebhook<Event = unknown>(options: WebhookOptions<Event>): WebhookDefinition<Event> {
  if (typeof options?.handle !== "function") throw new Error("defineWebhook({ verify, handle }) needs a handle function");
  if (typeof options.verify !== "string" && typeof options.verify?.verify !== "function") throw new Error("defineWebhook({ verify, handle }) needs a verifier, like stripeSignature({ secret })");
  return { ...options, [WEBHOOK_MARKER]: true };
}

/** Whether a value is a `defineWebhook(...)` result. */
export function isWebhookDefinition(value: unknown): value is WebhookDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[WEBHOOK_MARKER] === true;
}

/** The secrets a verifier tries, resolved for the request. */
export async function resolveSecrets(secret: WebhookSecret, ctx: { req: ServiceRequest; tenant?: string }): Promise<string[]> {
  const values = Array.isArray(secret) ? (secret as readonly WebhookSecretValue[]) : [secret as WebhookSecretValue];
  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value === "function") resolved.push(await value(ctx));
    else if (isSecretReference(value)) {
      const reader = (ctx.req as { secrets?: { get(reference: SecretReference): Promise<string> } }).secrets;
      resolved.push(reader ? await reader.get(value) : secretValue(value));
    } else resolved.push(String(value));
  }
  return resolved.filter((value) => value !== "");
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Whether two texts are equal, compared in constant time. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The `id` and `type` of a JSON body, when it has them. */
function bodyFields(rawBody: Uint8Array): { id?: string; type?: string } {
  try {
    const parsed = JSON.parse(text(rawBody)) as { id?: unknown; type?: unknown };
    return { ...(typeof parsed?.id === "string" ? { id: parsed.id } : {}), ...(typeof parsed?.type === "string" ? { type: parsed.type } : {}) };
  } catch {
    return {};
  }
}

const toleranceOf = (own: string | undefined, input: WebhookVerifyInput) => (own !== undefined ? (parseDuration(own) ?? input.tolerance) : input.tolerance);

/**
 * Verifies Stripe's `Stripe-Signature` (`t=<unix>,v1=<hex>`): the HMAC-SHA256 of `<t>.<raw body>` with the endpoint
 * secret, any `v1` matching, the timestamp within `tolerance` (default `webhooks.incoming.tolerance`); the delivery id
 * is the event's `id`.
 */
export function stripeSignature(options: { secret: WebhookSecret; tolerance?: string }): WebhookVerifier {
  return {
    name: "stripe",
    async verify(input) {
      const header = input.headers.get("stripe-signature");
      if (!header) return { ok: false, reason: "missing" };
      const parts = header.split(",").map((part) => part.trim().split("="));
      const timestamp = parts.find(([key]) => key === "t")?.[1];
      const signatures = parts.filter(([key, value]) => key === "v1" && value !== undefined).map(([, value]) => value!);
      if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return { ok: false, reason: "malformed" };
      const payload = `${timestamp}.${text(input.rawBody)}`;
      const secrets = await resolveSecrets(options.secret, { req: input.req, ...(input.tenant ? { tenant: input.tenant } : {}) });
      const matched = secrets.some((secret) => {
        const expected = createHmac("sha256", secret).update(payload).digest("hex");
        return signatures.some((signature) => sameText(signature, expected));
      });
      if (!matched) return { ok: false, reason: "mismatch" };
      if (Math.abs(input.now - Number(timestamp) * 1000) > toleranceOf(options.tolerance, input)) return { ok: false, reason: "expired" };
      const fields = bodyFields(input.rawBody);
      return { ok: true, ...(fields.id ? { deliveryId: fields.id } : {}), ...(fields.type ? { eventType: fields.type } : {}) };
    },
  };
}

/**
 * Verifies GitHub's `X-Hub-Signature-256` (`sha256=<hex>` of the HMAC-SHA256 of the raw body); the delivery id is
 * `X-GitHub-Delivery` and the event type `X-GitHub-Event`.
 */
export function githubSignature(options: { secret: WebhookSecret }): WebhookVerifier {
  return {
    name: "github",
    async verify(input) {
      const header = input.headers.get("x-hub-signature-256");
      if (!header) return { ok: false, reason: "missing" };
      if (!/^sha256=[0-9a-f]{64}$/i.test(header)) return { ok: false, reason: "malformed" };
      const secrets = await resolveSecrets(options.secret, { req: input.req, ...(input.tenant ? { tenant: input.tenant } : {}) });
      const given = header.slice(7).toLowerCase();
      if (!secrets.some((secret) => sameText(createHmac("sha256", secret).update(input.rawBody).digest("hex"), given))) return { ok: false, reason: "mismatch" };
      const deliveryId = input.headers.get("x-github-delivery") ?? undefined;
      const eventType = input.headers.get("x-github-event") ?? undefined;
      return { ok: true, ...(deliveryId ? { deliveryId } : {}), ...(eventType ? { eventType } : {}) };
    },
  };
}

/**
 * Verifies a Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) with `verifyWebhook`,
 * the timestamp within the tolerance; the delivery id is `webhook-id`.
 */
export function standardWebhookSignature(options: { secret: WebhookSecret; tolerance?: string }): WebhookVerifier {
  return {
    name: "standard-webhooks",
    async verify(input) {
      const id = input.headers.get("webhook-id");
      const timestamp = input.headers.get("webhook-timestamp");
      const signature = input.headers.get("webhook-signature");
      if (!id || !timestamp || !signature) return { ok: false, reason: "missing" };
      if (!/^\d+$/.test(timestamp) || !signature.split(" ").some((item) => item.startsWith("v1,"))) return { ok: false, reason: "malformed" };
      const secrets = await resolveSecrets(options.secret, { req: input.req, ...(input.tenant ? { tenant: input.tenant } : {}) });
      if (!verifyWebhook({ id, timestamp, body: text(input.rawBody), signature, secrets })) return { ok: false, reason: "mismatch" };
      if (Math.abs(input.now - Number(timestamp) * 1000) > toleranceOf(options.tolerance, input)) return { ok: false, reason: "expired" };
      const fields = bodyFields(input.rawBody);
      return { ok: true, deliveryId: id, ...(fields.type ? { eventType: fields.type } : {}) };
    },
  };
}

/** What `hmacSignature` takes. */
export interface HmacSignatureOptions {
  /** The header carrying the signature, like `x-signature`. */
  header: string;
  secret: WebhookSecret;
  algorithm: "sha1" | "sha256" | "sha512";
  encoding: "hex" | "base64";
  /** Removed from the header's value before comparing, like `sha256=`. */
  prefix?: string;
  /** The header carrying the delivery's id, when the sender sends one. */
  idHeader?: string;
}

/** Verifies any HMAC of the raw body sent in one header, as many services sign their webhooks. */
export function hmacSignature(options: HmacSignatureOptions): WebhookVerifier {
  return {
    name: "hmac",
    async verify(input) {
      let header = input.headers.get(options.header);
      if (!header) return { ok: false, reason: "missing" };
      if (options.prefix) {
        if (!header.startsWith(options.prefix)) return { ok: false, reason: "malformed" };
        header = header.slice(options.prefix.length);
      }
      if (header === "") return { ok: false, reason: "malformed" };
      const secrets = await resolveSecrets(options.secret, { req: input.req, ...(input.tenant ? { tenant: input.tenant } : {}) });
      const matches = secrets.some((secret) => {
        const expected = createHmac(options.algorithm, secret).update(input.rawBody).digest(options.encoding);
        return options.encoding === "hex" ? sameText(expected, header!.toLowerCase()) : sameText(expected, header!);
      });
      if (!matches) return { ok: false, reason: "mismatch" };
      const deliveryId = options.idHeader ? (input.headers.get(options.idHeader) ?? undefined) : undefined;
      const fields = bodyFields(input.rawBody);
      return { ok: true, ...(deliveryId ? { deliveryId } : {}), ...(fields.type ? { eventType: fields.type } : {}) };
    },
  };
}

/** The verified request a webhook route hands to its hooks and `handle`. */
export interface VerifiedWebhook {
  event: unknown;
  rawBody: Uint8Array;
  deliveryId?: string;
  eventType?: string;
}

/** The answer to a refused signature. */
export const invalidSignature = () => new HttpError(401, "Invalid webhook signature", { code: "INVALID_SIGNATURE" });

/** What the incoming runner needs from the running native. */
export interface IncomingOptions {
  logger: Logger;
  /** The route's timestamp tolerance and body limit, from the options and the route's own settings. */
  settings(route: { method: string; path: string }): { tolerance: string; maxBodySize: string | number };
  /** The verifier a name stands for. */
  verifierNamed(name: string): WebhookVerifier | undefined;
}

const verified = new WeakMap<ServiceRequest, VerifiedWebhook>();

/** A logger for `handle`, writing with the route. */
function routeLogger(logger: Logger, route: string): JobLogger {
  const write = (level: "info" | "warn" | "error") => (line: string, fields?: Record<string, unknown>) => safeLog(logger, level, { timestamp: new Date().toISOString(), message: String(line), ...fields, route });
  return { info: write("info"), warn: write("warn"), error: write("error") } as JobLogger;
}

/** The runner of `webhook.ts` routes: verification on the raw body, then the hooks, then `handle`. */
export function incomingRunner(options: IncomingOptions) {
  const verifierOf = (definition: WebhookDefinition, path: string): WebhookVerifier => {
    if (typeof definition.verify !== "string") return definition.verify;
    const found = options.verifierNamed(definition.verify);
    if (!found) throw new Error(`Unknown webhook verifier ${definition.verify} in POST ${path}`);
    return found;
  };
  const runner = {
    /**
     * Reads the raw body within the route's limit, verifies it and hands the request to `next` (the route's hooks and
     * `handle`), or answers 401 `Invalid webhook signature`.
     */
    async receive(input: { definition: unknown; method: string; path: string; repos: Repositories; req: ServiceRequest; res: ServiceResponse; next: Endpoint }): Promise<unknown> {
      const { req, path } = input;
      const definition = input.definition as WebhookDefinition;
      const settings = options.settings({ method: input.method, path });
      const maxBytes = (typeof settings.maxBodySize === "number" ? settings.maxBodySize : parseSize(settings.maxBodySize)) ?? 1024 * 1024;
      const current = bodyPolicyOf(req.raw)?.maxBytes;
      setBodyPolicy(req.raw, { maxBytes: current === undefined ? maxBytes : Math.min(current, maxBytes) });
      const rawBody = await readBodyBytes(req.raw);
      const tenant = (req.tenant as { id?: string } | undefined)?.id;
      const verifier = verifierOf(definition, path);
      const result = await verifier.verify({ headers: req.headers, rawBody, req, ...(tenant ? { tenant } : {}), tolerance: parseDuration(settings.tolerance) ?? 300_000, now: webhookClock.now() });
      if (!result.ok) {
        safeLog(options.logger, "warn", { timestamp: new Date().toISOString(), message: "webhook.incoming.rejected", route: `POST ${path}`, reason: result.reason });
        throw invalidSignature();
      }
      let event: unknown;
      try {
        event = rawBody.length === 0 ? undefined : JSON.parse(text(rawBody));
      } catch {
        throw new HttpError(400, "Invalid JSON body");
      }
      verified.set(req, { event, rawBody, ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}), ...(result.eventType ? { eventType: result.eventType } : {}) });
      (req as { json: () => Promise<unknown> }).json = () => Promise.resolve(event);
      return input.next(input.repos, req, input.res);
    },
    /** Runs `handle` for a verified request; the endpoint the hooks wrap. */
    async handle(input: { definition: unknown; path: string; repos: Repositories; req: ServiceRequest; res: ServiceResponse }): Promise<unknown> {
      const definition = input.definition as WebhookDefinition;
      const found = verified.get(input.req);
      if (!found) throw invalidSignature();
      await definition.handle(found.event, {
        req: input.req,
        repos: input.repos,
        rawBody: found.rawBody,
        headers: input.req.headers,
        deliveryId: found.deliveryId,
        eventType: found.eventType,
        log: routeLogger(options.logger, `POST ${input.path}`),
      });
      return { received: true };
    },
    /** The verified webhook of a request, for the native's dedupe. */
    verifiedOf: (req: ServiceRequest) => verified.get(req),
  };
  return runner;
}

export type IncomingRunner = ReturnType<typeof incomingRunner>;
