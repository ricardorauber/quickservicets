import { HttpError } from "../errors.ts";
import type { Repositories, RequestTenant, RequestUser, ServiceRequest, ServiceResponse } from "../hooks.ts";
import type { Logger } from "../logger.ts";
import type { Endpoint } from "./server.ts";

/** An open WebSocket, as the handlers of a `ws.ts` file receive it. */
export interface Socket<Out = unknown, D extends object = Record<string, unknown>> {
  /** Sends a string as a text frame, a `Uint8Array` as a binary frame, and any other value as JSON text. */
  send(data: Out | string | Uint8Array): void;
  /** Closes the socket with a code (default 1000) and a reason. */
  close(code?: number, reason?: string): void;
  /** The socket's id, a UUIDv7. */
  readonly id: string;
  /** The user of the upgrade request. */
  readonly user: RequestUser | undefined;
  /** The tenant of the upgrade request. */
  readonly tenant: RequestTenant | undefined;
  /** The route's path parameters. */
  readonly params: Readonly<Record<string, string>>;
  /** A per-socket object the handlers may fill. */
  data: D;
  /** 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
}

/** What every handler of a socket receives besides the socket: the upgrade request's values, kept for the socket's life. */
export interface SocketContext {
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  user: RequestUser | undefined;
  tenant: RequestTenant | undefined;
  /** The repositories of the request (its tenant's, with tenancy). */
  repos: Repositories;
  log: Logger;
  /** The upgrade request. */
  req: ServiceRequest;
}

/** The handlers of a `ws.ts` file. */
export interface SocketHandlers<D extends object = Record<string, unknown>> {
  open?(ws: Socket<unknown, D>, ctx: SocketContext): void | Promise<void>;
  /** Receives text frames as strings and binary frames as `Uint8Array`. */
  message(ws: Socket<unknown, D>, data: string | Uint8Array, ctx: SocketContext): unknown;
  close?(ws: Socket<unknown, D>, code: number, reason: string, ctx: SocketContext): void | Promise<void>;
  drain?(ws: Socket<unknown, D>, ctx: SocketContext): void | Promise<void>;
}

const SOCKET = Symbol.for("quickservicets.socket");

/** What `defineSocket` returns, the default export of a `ws.ts` endpoint. */
export interface SocketDefinition {
  readonly [SOCKET]: true;
  readonly handlers: SocketHandlers<object>;
}

/**
 * Declares the handlers of an `endpoints/<path>/ws.ts` file, served as `GET <path>` and upgraded to a WebSocket once
 * the handler middlewares (authentication, tenancy, `@auth`) and the endpoint's pre-hooks passed:
 *
 * ```ts
 * export default defineSocket({ message: (ws, data) => ws.send(data) });
 * ```
 */
export function defineSocket<D extends object = Record<string, unknown>>(handlers: SocketHandlers<D>): SocketDefinition {
  if (typeof handlers !== "object" || handlers === null) throw new Error("defineSocket needs an object of handlers");
  for (const name of ["open", "message", "close", "drain"] as const) {
    if (handlers[name] !== undefined && typeof handlers[name] !== "function") throw new Error(`defineSocket: ${name} must be a function`);
  }
  return { [SOCKET]: true, handlers: handlers as SocketHandlers<object> };
}

/** Whether a value is what `defineSocket(...)` returns. */
export function isSocketDefinition(value: unknown): value is SocketDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SOCKET] === true;
}

/** Answers the upgrade request of a `ws.ts` endpoint; the `realtime` native sets it. */
export type SocketRunner = (definition: SocketDefinition, repos: Repositories, req: ServiceRequest, res: ServiceResponse) => Promise<Response>;

const RUNNER = Symbol.for("quickservicets.socket.runner");
const slot = globalThis as unknown as { [RUNNER]?: SocketRunner };

/** Sets (or, with undefined, removes) what serves `ws.ts` endpoints; without one they answer 404. */
export function setSocketRunner(runner: SocketRunner | undefined): void {
  slot[RUNNER] = runner;
}

/** The route handler of a `ws.ts` endpoint: 404 `Route not found` while no runner serves WebSockets. */
export function socketEndpoint(definition: SocketDefinition): Endpoint {
  return (repos, req, res) => {
    const runner = slot[RUNNER];
    if (!runner) throw new HttpError(404, "Route not found");
    return runner(definition, repos, req, res);
  };
}
