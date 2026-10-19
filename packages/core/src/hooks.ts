import type { RequestJobs } from "./jobs/triggers.ts";

/**
 * The repositories available to endpoints and hooks, keyed by repository key. The build augments this
 * interface with one typed repository per entity.
 */
export interface Repositories {}

/** The request passed to endpoints and hooks. */
export interface ServiceRequest<Body = unknown> {
  /** The request id, also returned in the `x-request-id` response header. */
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** The native request. */
  readonly raw: Request;
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
}

/** Lets endpoints and hooks set the status and headers of a data response. */
export interface ServiceResponse {
  status(code: number): ServiceResponse;
  header(name: string, value: string): ServiceResponse;
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

const HOOK_MARKER = Symbol.for("quickservice.hook");

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
