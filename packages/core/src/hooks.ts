/**
 * The repositories available to endpoints and hooks, keyed by repository key. The build augments this
 * interface with one typed repository per entity.
 */
export interface Repositories {}

/** The request passed to endpoints and hooks. */
export interface ServiceRequest<Body = unknown> {
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

export type HookDefinition =
  | { readonly [HOOK_MARKER]: true; phase: "pre"; fn: PreHookFn }
  | { readonly [HOOK_MARKER]: true; phase: "post"; fn: PostHookFn };

export function definePreHook(fn: PreHookFn): HookDefinition {
  return { [HOOK_MARKER]: true, phase: "pre", fn };
}

export function definePostHook(fn: PostHookFn): HookDefinition {
  return { [HOOK_MARKER]: true, phase: "post", fn };
}

export function isHookDefinition(value: unknown): value is HookDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[HOOK_MARKER] === true;
}

/** A hook attached to an endpoint or entity route, with the arguments written in its tag. */
export interface HookCall {
  name: string;
  args: string[];
}
