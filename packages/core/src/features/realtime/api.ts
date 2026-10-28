import type { ForeignConnection, SocketHooks } from "./sockets.ts";

/** The shared WebSocket handler as another feature uses it for connections of its own, like proxied sockets. */
export interface ForeignSockets {
  /** Whether Bun's WebSocket handler is passed to the server. */
  readonly passed: boolean;
  /** `realtime.websockets.maxMessageSize` in bytes. */
  readonly maxMessageSize: number;
  /** `realtime.websockets.idleTimeout` in milliseconds. */
  readonly idleTimeoutMs: number;
  /** Checks an upgrade: the origin against `realtime.websockets.origins` (403) and `maxConnections` (503). */
  admit(req: ServiceRequest): Promise<void>;
  /** Upgrades the request to the connection, with response headers like the chosen subprotocol; false when it cannot. */
  upgrade(req: ServiceRequest, connection: ForeignConnection, headers?: Record<string, string>): boolean;
}
import type { FeatureHook, RequestTenant, RequestUser, ServiceRequest, Sockets, SocketTransport, WriteEvent } from "../public.ts";

/** What `sse.beforeDeliver` hooks receive for each change and stream: returning false skips it for that stream. */
export interface ChangeDelivery {
  req: ServiceRequest;
  user: RequestUser | undefined;
  tenant: RequestTenant | undefined;
  event: WriteEvent;
  /** The entity's name, like `Task`. */
  entity: string;
}

/** What `sse.beforeSend` hooks receive before a change message is written: they return changed data or null. */
export interface ChangeSend {
  req: ServiceRequest;
  event: WriteEvent;
  data: unknown;
}

/** The feature API of `realtime`, reached with `ctx.feature("realtime")` from a feature that lists it in `requires` or `after`. */
export interface RealtimeApi {
  /** Appends a `beforeDeliver` hook after the config's; returning false skips the change for that stream. */
  beforeDeliver(fn: FeatureHook<ChangeDelivery | false, undefined>): void;
  /** Appends a `beforeSend` hook after the config's; it returns changed data, or null to skip the message. */
  beforeSend(fn: FeatureHook<ChangeSend | null, undefined>): void;
  /** Sends a change to the open change streams of an entity on this worker, without a write. */
  publish(entity: string, event: WriteEvent): void;
  /** Publishing to socket rooms, disconnecting sockets and counting them, as `sockets` of `@quickservicets/core` does. */
  sockets(): Sockets;
  /**
   * Appends a WebSocket hook (`beforeConnect`, `afterConnect`, `beforeMessage`, `beforeSubscribe`, `beforePublish` or
   * `onClose`) after the config's.
   */
  addHook<K extends keyof SocketHooks>(name: K, fn: SocketHooks[K][number]): void;
  /**
   * The shared WebSocket handler for connections of another feature, or undefined while `realtime.websockets` is off;
   * `pass` (during setup) makes the server get Bun's WebSocket handler even without `ws.ts` routes.
   */
  foreignSockets(pass: boolean): ForeignSockets | undefined;
  /** Replaces the local transport during setup; a second source (the config or another feature) fails startup naming both. */
  setTransport(transport: SocketTransport): void;
}
