import type { RequestJobs } from "./jobs/triggers.ts";
import type { ClientCertificate } from "./client-certificates.ts";

/**
 * The repositories available to endpoints and hooks, keyed by repository key. The build augments this
 * interface with one typed repository per entity.
 */
export interface Repositories {}

/** The signed-in user of a request; empty until a feature or the project declares its fields by declaration merging. */
export interface RequestUser {}

/** The tenant of a request; empty until a feature or the project declares its fields by declaration merging. */
export interface RequestTenant {}

/** The feature flags of a request; empty until a feature or the project declares its fields by declaration merging. */
export interface RequestFlags {}

/**
 * Properties features add to every request with the `request` field of their definitions, computed on first read;
 * each feature declares its own by declaration merging.
 */
export interface RequestExtensions {}

/** The request passed to endpoints and hooks. */
export interface ServiceRequest<Body = unknown> extends RequestExtensions {
  /** The request id, also returned in the `x-request-id` response header. */
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** The native request. */
  readonly raw: Request;
  /**
   * The caller's client certificate, verified by the service's TLS handshake (`security.mtls`) or by a trusted proxy
   * that forwarded it; undefined without one.
   */
  readonly client: ClientCertificate | undefined;
  /** Free-form values shared by hooks and the handler during one request. */
  readonly context: Record<string, unknown>;
  /** The parsed JSON body, parsed once and cached. */
  json(): Promise<Body>;
  /**
   * The typed query items of a GET or DELETE endpoint, converted and validated from the query string;
   * `{}` for endpoints without them.
   */
  readonly queryItems: Body extends object ? Body : Record<string, unknown>;
  /** Starts the project's jobs on demand. */
  readonly jobs: RequestJobs;
  /** The matched route's path pattern, like `/users/[id]`. */
  readonly route: string;
  /**
   * The client's address, computed on first read: the socket's peer address, or the address forwarding headers give
   * when the peer is a proxy the project trusts (`security.proxy`); `unknown` without a socket.
   */
  readonly ip: string;
  /** The signed-in user, set by a middleware. */
  user: RequestUser | undefined;
  /** The request's tenant, set by a middleware. */
  tenant: RequestTenant | undefined;
  /** The request's feature flags, set by a middleware. */
  flags: RequestFlags | undefined;
}

/** The properties every request has, which a feature's `request` field may not use. */
export const REQUEST_PROPERTIES = ["id", "method", "path", "params", "query", "headers", "raw", "context", "json", "queryItems", "jobs", "route", "ip", "user", "tenant", "flags", "client"] as const;

/** Lets endpoints and hooks set the status and headers of a data response. */
export interface ServiceResponse {
  status(code: number): ServiceResponse;
  header(name: string, value: string): ServiceResponse;
  /**
   * Sets the `ETag` header to a record's entity tag, or to a text (quoted when unquoted), and makes the response a
   * 304 without a body when the request's `If-None-Match` matches it. Needs the `etag` native.
   */
  etag(value: object | string): ServiceResponse;
}

export type HookPhase = "pre" | "post";

export type PreHookFn = (
  repos: Repositories,
  req: ServiceRequest,
  res: ServiceResponse,
  args: string[],
) => void | Promise<void>;

export type PostHookFn = (
  data: unknown,
  repos: Repositories,
  req: ServiceRequest,
  res: ServiceResponse,
  args: string[],
) => unknown | Promise<unknown>;

const HOOK_MARKER = Symbol.for("quickservicets.hook");

/** How a hook appears in the API docs: extra error responses and the security scheme it enforces. */
export interface HookDocs {
  responses?: number[];
  security?: "bearer";
}

export interface HookOptions {
  docs?: HookDocs;
}

export type HookDefinition =
  | { readonly [HOOK_MARKER]: true; phase: "pre"; fn: PreHookFn; docs?: HookDocs }
  | { readonly [HOOK_MARKER]: true; phase: "post"; fn: PostHookFn; docs?: HookDocs };

export function definePreHook(fn: PreHookFn, options: HookOptions = {}): HookDefinition {
  return { [HOOK_MARKER]: true, phase: "pre", fn, ...(options.docs ? { docs: options.docs } : {}) };
}

export function definePostHook(fn: PostHookFn, options: HookOptions = {}): HookDefinition {
  return { [HOOK_MARKER]: true, phase: "post", fn, ...(options.docs ? { docs: options.docs } : {}) };
}

export function isHookDefinition(value: unknown): value is HookDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[HOOK_MARKER] === true;
}

/** A hook attached to an endpoint or entity route, with the arguments written in its tag. */
export interface HookCall {
  name: string;
  args: string[];
}
