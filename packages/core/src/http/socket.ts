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

/** The handlers of a `ws.ts` file without message types: frames arrive as strings and `Uint8Array`. */
export interface SocketHandlers<D extends object = Record<string, unknown>> {
  open?(ws: Socket<unknown, D>, ctx: SocketContext): void | Promise<void>;
  /** Receives text frames as strings and binary frames as `Uint8Array`. */
  message(ws: Socket<unknown, D>, data: string | Uint8Array, ctx: SocketContext): unknown;
  close?(ws: Socket<unknown, D>, code: number, reason: string, ctx: SocketContext): void | Promise<void>;
  drain?(ws: Socket<unknown, D>, ctx: SocketContext): void | Promise<void>;
}

/** The message types of a socket: what clients send (`in`), what it sends (`out`), and its `ws.data`. */
export interface SocketTypes {
  in?: unknown;
  out?: unknown;
  data?: object;
}

type InOf<T extends SocketTypes> = T extends { in: infer I } ? I : unknown;
type OutOf<T extends SocketTypes> = T extends { out: infer O } ? O : unknown;
type DataOf<T extends SocketTypes> = T extends { data: infer D extends object } ? D : Record<string, unknown>;
type TypeOf<I> = I extends { type: infer K extends string } ? K : never;

/**
 * The handlers of a socket with message types: text frames are parsed as JSON and validated against `in`, routed by
 * their `type` to `on`, else to `message`; a returned value answers a message that carries an `id`.
 */
export interface TypedSocketHandlers<T extends SocketTypes> {
  open?(ws: Socket<OutOf<T>, DataOf<T>>, ctx: SocketContext): void | Promise<void>;
  /** Receives the validated messages no `on` entry handles. */
  message?(ws: Socket<OutOf<T>, DataOf<T>>, data: InOf<T>, ctx: SocketContext): unknown;
  /** One handler per `type` of a discriminated `in` union, each typed by its member. */
  on?: { [K in TypeOf<InOf<T>>]?: (ws: Socket<OutOf<T>, DataOf<T>>, message: Extract<InOf<T>, { type: K }>, ctx: SocketContext) => unknown };
  close?(ws: Socket<OutOf<T>, DataOf<T>>, code: number, reason: string, ctx: SocketContext): void | Promise<void>;
  drain?(ws: Socket<OutOf<T>, DataOf<T>>, ctx: SocketContext): void | Promise<void>;
}

/** The handlers of either form, as the runtime reads them. */
export interface AnySocketHandlers {
  open?(ws: Socket, ctx: SocketContext): void | Promise<void>;
  message?(ws: Socket, data: unknown, ctx: SocketContext): unknown;
  on?: Readonly<Record<string, ((ws: Socket, message: never, ctx: SocketContext) => unknown) | undefined>>;
  close?(ws: Socket, code: number, reason: string, ctx: SocketContext): void | Promise<void>;
  drain?(ws: Socket, ctx: SocketContext): void | Promise<void>;
}

const SOCKET = Symbol.for("quickservicets.socket");

/** What `defineSocket` returns, the default export of a `ws.ts` endpoint. */
export interface SocketDefinition {
  readonly [SOCKET]: true;
  readonly handlers: AnySocketHandlers;
  /** The validator of incoming messages the build generated from `in`, set when the app starts. */
  readonly messages?: MessageValidator;
}

/** Checks a parsed message: no issues for a valid one; for a discriminated union, also the validator of each type. */
export interface MessageValidator {
  validate(value: unknown): { path: string; message: string }[] | undefined;
  /** The validators by the `type` of a discriminated union, so a message is checked against its member only. */
  byType?: ReadonlyMap<string, (value: unknown) => { path: string; message: string }[] | undefined>;
}

/**
 * Declares the handlers of an `endpoints/<path>/ws.ts` file, served as `GET <path>` and upgraded to a WebSocket once
 * the handler middlewares (authentication, tenancy, `@auth`) and the endpoint's pre-hooks passed. Without a type
 * parameter `message` receives raw frames; with `defineSocket<{ in; out; data? }>` text frames are parsed and validated
 * against `in` and routed by `type`:
 *
 * ```ts
 * export default defineSocket({ message: (ws, data) => ws.send(data) });
 * export default defineSocket<{ in: { type: "say"; text: string }; out: { type: "said"; text: string } }>({
 *   on: { say: (ws, m) => ws.send({ type: "said", text: m.text }) },
 * });
 * ```
 */
export function defineSocket<D extends object & { in?: never; out?: never } = Record<string, unknown>>(handlers: SocketHandlers<D>): SocketDefinition;
export function defineSocket<T extends SocketTypes>(handlers: TypedSocketHandlers<T>): SocketDefinition;
export function defineSocket(handlers: AnySocketHandlers): SocketDefinition {
  if (typeof handlers !== "object" || handlers === null) throw new Error("defineSocket needs an object of handlers");
  for (const name of ["open", "message", "close", "drain"] as const) {
    if (handlers[name] !== undefined && typeof handlers[name] !== "function") throw new Error(`defineSocket: ${name} must be a function`);
  }
  if (handlers.on !== undefined) {
    if (typeof handlers.on !== "object" || handlers.on === null) throw new Error("defineSocket: on must map message types to functions");
    for (const [type, fn] of Object.entries(handlers.on)) if (fn !== undefined && typeof fn !== "function") throw new Error(`defineSocket: on.${type} must be a function`);
  }
  if (handlers.message === undefined && handlers.on === undefined) throw new Error("defineSocket needs message or on");
  return { [SOCKET]: true, handlers };
}

/** The definition with the validator of its incoming messages. */
export function withMessageValidator(definition: SocketDefinition, messages: MessageValidator | undefined): SocketDefinition {
  return messages ? { [SOCKET]: true, handlers: definition.handlers, messages } : definition;
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
