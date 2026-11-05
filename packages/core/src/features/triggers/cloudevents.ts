import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, secretValue, type SecretReference } from "../public.ts";
import type { TriggerEvent, TriggerSource, TriggerSourceRef } from "./source.ts";

/** The kind of the built-in CloudEvents source. */
export const CLOUDEVENTS_KIND = "cloudevents";

/** The issuer of Google-signed OIDC tokens, like those of Pub/Sub push and Eventarc. */
export const GOOGLE_ISSUER = "https://accounts.google.com";

/** How a push route checks who sent an event. */
export type CloudEventsAuth =
  /** A shared token sent as `Authorization: Bearer <token>`, compared in constant time. */
  | { bearer: string | SecretReference }
  /** A JWT in `Authorization: Bearer`, signed by the issuer's keys, for the audience (and service account `email`). */
  | { oidc: { audience: string; issuer?: string; email?: string } };

/** What `cloudEvents()` takes. */
export interface CloudEventsOptions {
  /** The event type, exact or a prefix ending in `*`, like `google.cloud.storage.object.v1.*` (default: any). */
  type?: string;
  /** The event source, exact or a prefix ending in `*` (default: any). */
  source?: string;
  /** The push route's path (default `/_triggers/<trigger name>`). */
  path?: string;
  /** Who may push events (default: anyone who reaches the route). */
  auth?: CloudEventsAuth;
}

/** A reference to the built-in `cloudevents` source. */
export interface CloudEventsRef extends TriggerSourceRef, CloudEventsOptions {
  kind: "cloudevents";
}

/**
 * A reference to the built-in CloudEvents source: events pushed over HTTP in the CloudEvents format (binary,
 * structured or batch mode), as Google Eventarc, Pub/Sub push, Knative and Azure Event Grid send them, on the trigger's
 * route `POST /_triggers/<name>` (or `path`).
 */
export function cloudEvents(options: CloudEventsOptions = {}): CloudEventsRef {
  return { kind: CLOUDEVENTS_KIND, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as CloudEventsRef;
}

/** The default push path of a trigger. */
export const pushPath = (ref: CloudEventsRef, trigger: string) => ref.path ?? `/_triggers/${trigger}`;

/** Whether a value matches an exact text or a prefix ending in `*`; any value without a pattern. */
export function matchesPattern(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

/** The 400 of an event that is not a valid CloudEvent. */
export const invalidCloudEvent = (reason: string) => new HttpError(400, `Invalid CloudEvent: ${reason}`, { code: "VALIDATION_ERROR" });

/** The 401 of a push whose credentials do not verify. */
export const invalidEventCredentials = () => new HttpError(401, "Invalid event credentials", { code: "INVALID_SIGNATURE" });

const REQUIRED = ["id", "type", "source", "specversion"] as const;
const CORE_ATTRIBUTES = new Set(["id", "type", "source", "specversion", "time", "subject", "data", "data_base64"]);
const isJson = (type: string | null | undefined) => {
  const base = (type ?? "").split(";")[0]!.trim().toLowerCase();
  return base === "application/json" || base.endsWith("+json") || base === "text/json";
};

/** One structured CloudEvent (a JSON object) as a trigger event; throws the 400 for a missing required attribute. */
export function structuredEvent(value: unknown): TriggerEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidCloudEvent("expected a JSON object");
  const event = value as Record<string, unknown>;
  for (const name of REQUIRED) if (typeof event[name] !== "string" || event[name] === "") throw invalidCloudEvent(`missing ${name}`);
  if (event.specversion !== "1.0") throw invalidCloudEvent("specversion must be 1.0");
  const attributes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(event)) if (!CORE_ATTRIBUTES.has(name) && entry !== undefined && entry !== null) attributes[name] = typeof entry === "string" ? entry : JSON.stringify(entry);
  attributes.source = String(event.source);
  attributes.specversion = "1.0";
  const contentType = typeof event.datacontenttype === "string" ? event.datacontenttype : "application/json";
  const data = typeof event.data_base64 === "string" ? new Uint8Array(Buffer.from(event.data_base64, "base64")) : typeof event.data === "string" && isJson(contentType) ? parseJson(event.data) : event.data;
  return {
    id: String(event.id),
    kind: CLOUDEVENTS_KIND,
    type: String(event.type),
    time: typeof event.time === "string" ? new Date(event.time) : new Date(),
    ...(typeof event.subject === "string" ? { subject: event.subject } : {}),
    data,
    attributes,
    attempt: 1,
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * The events of a pushed request: binary mode (`ce-*` headers with the data as the body), structured mode
 * (`application/cloudevents+json`) or batch mode (`application/cloudevents-batch+json`).
 */
export async function requestEvents(request: Request): Promise<TriggerEvent[]> {
  const contentType = request.headers.get("content-type");
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const body = new Uint8Array(await request.arrayBuffer());
  const text = () => new TextDecoder().decode(body);
  const json = () => {
    try {
      return JSON.parse(text()) as unknown;
    } catch {
      throw invalidCloudEvent("the body is not JSON");
    }
  };
  if (base === "application/cloudevents+json") return [structuredEvent(json())];
  if (base === "application/cloudevents-batch+json") {
    const batch = json();
    if (!Array.isArray(batch)) throw invalidCloudEvent("a batch must be a JSON array");
    return batch.map(structuredEvent);
  }
  // Binary mode: the attributes are ce-* headers and the body is the data.
  const header = (name: string) => request.headers.get(`ce-${name}`) ?? undefined;
  for (const name of REQUIRED) if (!header(name)) throw invalidCloudEvent(`missing ${name}`);
  if (header("specversion") !== "1.0") throw invalidCloudEvent("specversion must be 1.0");
  const attributes: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    if (!name.startsWith("ce-")) continue;
    const attribute = name.slice(3);
    if (!["id", "type", "time", "subject"].includes(attribute)) attributes[attribute] = value;
  }
  if (contentType) attributes.datacontenttype = contentType;
  const data = body.byteLength === 0 ? undefined : isJson(contentType) ? parseJson(text()) : body;
  return [
    {
      id: header("id")!,
      kind: CLOUDEVENTS_KIND,
      type: header("type")!,
      time: header("time") ? new Date(header("time")!) : new Date(),
      ...(header("subject") ? { subject: header("subject")! } : {}),
      data,
      attributes,
      attempt: 1,
    },
  ];
}

/** Two texts compared in constant time, through their hashes so their lengths do not leak. */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** A JSON Web Key of an issuer's key set. */
export type SigningKey = Record<string, unknown> & { kid?: string };

/** The signing keys of an issuer, by key id; `refresh` reloads them when a token names an unknown key. */
export type KeyLoader = (issuer: string, refresh?: boolean) => Promise<Map<string, SigningKey>>;

const base64url = (text: string) => new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const decodePart = (text: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64url(text))) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether an OIDC token verifies: an RS256 signature by one of the issuer's keys, the audience, the issuer (Google
 * also writes it without `https://`), an expiry in the future and, when asked, the service account email (verified).
 */
export async function verifyOidcToken(token: string, options: { audience: string; issuer?: string; email?: string }, keys: KeyLoader, now = Date.now()): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decodePart(parts[0]!);
  const claims = decodePart(parts[1]!);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;
  const issuer = options.issuer ?? GOOGLE_ISSUER;
  let key = (await keys(issuer)).get(header.kid);
  if (!key) key = (await keys(issuer, true)).get(header.kid);
  if (!key) return false;
  const verified = await crypto.subtle
    .importKey("jwk", key as never, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
    .then((imported) => crypto.subtle.verify("RSASSA-PKCS1-v1_5", imported, base64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))
    .catch(() => false);
  if (!verified) return false;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) return false;
  if (claims.iss !== issuer && claims.iss !== issuer.replace(/^https:\/\//, "")) return false;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return false;
  if (options.email !== undefined && (claims.email !== options.email || claims.email_verified === false)) return false;
  return true;
}

/** Checks a pushed request's credentials against the reference's `auth`; throws the 401 when they do not verify. */
export async function checkPushAuth(request: Request, auth: CloudEventsAuth | undefined, keys: KeyLoader): Promise<void> {
  if (!auth) return;
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token) throw invalidEventCredentials();
  if ("bearer" in auth) {
    if (!sameText(token, secretValue(auth.bearer))) throw invalidEventCredentials();
    return;
  }
  if (!(await verifyOidcToken(token, auth.oidc, keys))) throw invalidEventCredentials();
}

/**
 * The built-in `cloudevents` source: events pushed to each trigger's route, decoded from binary, structured and batch
 * requests; a reference matches by `type` and `source`, exact or by prefix. Structured CloudEvents a platform hands the
 * service as raw events (objects or arrays with `specversion`) are recognized too.
 */
export const cloudEventsSource: TriggerSource<CloudEventsRef> = {
  kind: CLOUDEVENTS_KIND,
  recognize: (_platform, raw) => {
    const first = Array.isArray(raw) ? raw[0] : raw;
    return typeof first === "object" && first !== null && (first as { specversion?: unknown }).specversion === "1.0" && typeof (first as { id?: unknown }).id === "string";
  },
  decode: (raw) => (Array.isArray(raw) ? raw : [raw]).map(structuredEvent),
  matches: (ref, event) => matchesPattern(ref.type, event.type) && matchesPattern(ref.source, event.attributes.source),
  push: { path: pushPath },
};
