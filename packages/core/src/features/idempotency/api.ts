import type { FeatureHook, ServiceRequest } from "../public.ts";
import type { BeginResult, IdempotencyRecord, StoredResponse } from "./store.ts";

/** Where idempotency keys live: the `IdempotencyKey` entity by default, or a project's store (`idempotency.store`). */
export interface IdempotencyStore {
  /**
   * Starts a request of a scope: stores a running record unless one exists, and tells whether the request runs
   * (`new`), replays (`replay`), used the key with another request (`reused`) or waits for one in progress (`inUse`).
   */
  begin(input: { scope: string; fingerprint: string; ttlMs: number }): Promise<BeginResult>;
  /** Stores the response of a running record, kept until `ttlMs` from now. */
  complete(record: IdempotencyRecord, response: StoredResponse, ttlMs: number): Promise<unknown>;
  /** Deletes a record, so a retry of its scope runs again. */
  release(record: IdempotencyRecord): Promise<void>;
  /** Deletes the expired records, resolving with how many. */
  cleanup(): Promise<number>;
}

/** What `beforeReplay` and `afterStore` hooks receive. */
export interface IdempotencyStep {
  req: ServiceRequest;
  record: IdempotencyRecord;
}

/** What `onConflict` hooks observe: a key used with another request, or one in progress. */
export interface IdempotencyConflict {
  req: ServiceRequest;
  kind: "reused" | "inUse";
}

/** The feature API of `idempotency`, reached with `ctx.feature("idempotency")` from a feature that lists it in `requires` or `after`. */
export interface IdempotencyApi {
  /** Appends a `beforeReplay` hook after the config's; returning false runs the request again instead of replaying. */
  addHook(name: "beforeReplay", fn: FeatureHook<IdempotencyStep | false, undefined>): void;
  /** Appends an `afterStore` hook after the config's. */
  addHook(name: "afterStore", fn: FeatureHook<IdempotencyStep, undefined>): void;
  /** Appends an `onConflict` hook after the config's. */
  addHook(name: "onConflict", fn: FeatureHook<IdempotencyConflict, undefined>): void;
}
