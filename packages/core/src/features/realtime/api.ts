import type { FeatureHook, RequestTenant, RequestUser, ServiceRequest, Sockets, WriteEvent } from "../public.ts";

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
}
