import type { RequestTenant, RequestUser, ServiceRequest } from "../hooks.ts";

/** What a dispatched request inherits: a request, or these fields of a caller outside requests. */
export interface DispatchSource {
  /** The request id the dispatched request keeps (default: a new one). */
  id?: string;
  user?: RequestUser | undefined;
  tenant?: RequestTenant | undefined;
  /** How the caller authenticated, as `req.auth` gives it. */
  auth?: unknown;
  ip?: string;
}

/** The route a dispatch runs. */
export interface DispatchCall {
  method: string;
  /** The path, like `/posts/42`; a query string in it is kept. */
  path: string;
  /** Query parameters added to the path's, as `?name=value` would give them; an array repeats the parameter. */
  query?: Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>;
  /** The JSON body. */
  body?: unknown;
}

/** The answer of a dispatched route. */
export interface DispatchResult {
  status: number;
  headers: Record<string, string>;
  /** The parsed JSON body, or undefined for an empty or non-JSON body. */
  body: unknown;
}

/** Runs a route of one server in process. */
export type Dispatcher = (from: DispatchSource, call: DispatchCall) => Promise<DispatchResult>;

const SLOT = Symbol.for("quickservicets.dispatch");
const state = ((globalThis as unknown as Record<symbol, unknown>)[SLOT] ??= {
  owners: new WeakMap<ServiceRequest, Dispatcher>(),
  inherited: new WeakMap<ServiceRequest, DispatchSource>(),
  latest: undefined,
}) as { owners: WeakMap<ServiceRequest, Dispatcher>; inherited: WeakMap<ServiceRequest, DispatchSource>; latest: Dispatcher | undefined };

/** Records the server a request belongs to, so a dispatch from it runs on the same server. */
export function ownRequest(req: ServiceRequest, dispatcher: Dispatcher): void {
  state.owners.set(req, dispatcher);
}

/** Makes a server's dispatcher the one dispatches from outside requests use. */
export function setLatestDispatcher(dispatcher: Dispatcher): void {
  state.latest = dispatcher;
}

/** Marks a request as dispatched, with what it inherited. */
export function markDispatched(req: ServiceRequest, from: DispatchSource): void {
  state.inherited.set(req, from);
}

/**
 * What a dispatched request inherited from its caller, or undefined for a request that came over HTTP; the `auth` and
 * `tenancy` natives keep these values instead of resolving them again.
 */
export function dispatchedFrom(req: ServiceRequest): DispatchSource | undefined {
  return state.inherited.get(req);
}

/**
 * Runs a route of the service in process, with the handler-stage middleware, hooks, field selection, populate and
 * handler an HTTP request to it would run (the request-stage middleware already ran for the caller's request). The
 * dispatched request inherits the user, tenant, auth, ip and request id of `from`; errors come back as their status and
 * error body, never thrown, and an unknown route answers 404.
 */
export async function dispatchRoute(from: ServiceRequest | DispatchSource, call: DispatchCall): Promise<DispatchResult> {
  const dispatcher = state.owners.get(from as ServiceRequest) ?? state.latest;
  if (!dispatcher) throw new Error("dispatchRoute() needs a running service");
  return dispatcher(from as DispatchSource, call);
}
