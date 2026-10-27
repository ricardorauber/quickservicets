import type { StoredRecord } from "./adapter.ts";
import type { WriteCause } from "./write-observers.ts";

/** Who caused an event: ids of the request's user and tenant, or the job or queue it ran for. */
export interface EventActor {
  user?: string;
  tenant?: string;
  job?: string;
  queue?: string;
  /** The database scope the event was created in (`tenant:<id>` for tenants), when not the root one. */
  scope?: string;
}

/** The operations of write events. */
export type WriteOperation = "created" | "updated" | "deleted";

interface WriteEventBase<O extends WriteOperation> {
  /** A UUIDv7, in creation order. */
  id: string;
  /** `<entity in lower camel case>.<operation>`, like `user.created` or `orderItem.deleted`. */
  type: string;
  /** The entity's name, like `User`. */
  entity: string;
  operation: O;
  recordId: string;
  /** The top-level fields whose stored values changed, `updatedAt` excluded. */
  changed: string[];
  cause: WriteCause;
  actor: EventActor;
  requestId?: string;
  at: Date;
}

/**
 * A record created, updated or deleted by a repository write, with the stored record before (null for a create) and
 * after (null for a delete).
 */
export type WriteEvent<T = StoredRecord, O extends WriteOperation = WriteOperation> = O extends "created"
  ? WriteEventBase<"created"> & { before: null; after: T }
  : O extends "updated"
    ? WriteEventBase<"updated"> & { before: T; after: T }
    : WriteEventBase<"deleted"> & { before: T; after: null };

/** An event published with `events.emit(type, payload)`. */
export interface CustomEvent<P = unknown> {
  /** A UUIDv7, in creation order. */
  id: string;
  /** Lowercase dot-separated segments, like `invoice.paid`. */
  type: string;
  payload: P;
  actor: EventActor;
  requestId?: string;
  at: Date;
}

/** Any event on the bus. */
export type AnyEvent = WriteEvent | CustomEvent;

/**
 * The events of the service by type. Projects and features add their custom events with their payloads
 * (`interface EventMap { "invoice.paid": { invoiceId: string } }`), and the build adds the write events of every entity
 * (`"user.created": WriteEvent<User, "created">`).
 */
export interface EventMap {}

type Split<S extends string> = S extends `${infer Head}.${infer Rest}` ? [Head, ...Split<Rest>] : [S];

type SegmentsMatch<P extends string[], K extends string[]> = P extends [infer PH extends string, ...infer PR extends string[]]
  ? K extends [infer KH extends string, ...infer KR extends string[]]
    ? PH extends "*"
      ? SegmentsMatch<PR, KR>
      : PH extends KH
        ? SegmentsMatch<PR, KR>
        : false
    : false
  : K extends []
    ? true
    : false;

/** Whether the event pattern `P` matches the event type `K`, at the type level. */
export type PatternMatches<P extends string, K extends string> = P extends "*"
  ? true
  : P extends `${infer Entity}.written`
    ? K extends `${infer KE}.${WriteOperation}`
      ? SegmentsMatch<Split<Entity>, Split<KE>>
      : false
    : SegmentsMatch<Split<P>, Split<K>>;

/** The event of a type of `EventMap`: write events as declared, custom events wrapping their payload. */
export type EventOf<K extends keyof EventMap & string> = K extends `${string}.${WriteOperation}` ? EventMap[K] : CustomEvent<EventMap[K]>;

type Mapped<P extends string> = { [K in keyof EventMap & string]: PatternMatches<P, K> extends true ? EventOf<K> : never }[keyof EventMap & string];

/** The events a pattern receives: those of `EventMap` it matches, or any event when it matches none of them. */
export type EventFor<P extends string> = P extends "*" ? AnyEvent : [Mapped<P>] extends [never] ? AnyEvent : Mapped<P>;

/** The payload `events.emit` takes for a type: its `EventMap` entry, or anything for a type the map does not list. */
export type PayloadOf<K extends string> = K extends keyof EventMap ? EventMap[K] : unknown;
