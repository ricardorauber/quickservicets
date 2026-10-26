import type { FeatureHook, WriteEvent } from "../public.ts";
import type { HistoryVersion } from "./model.ts";
import type { NewVersion, VersionPage, VersionQuery } from "./store.ts";

/**
 * Where versions are kept: the `<entity>_history` tables by default, or a project's store (`history.store`), such as
 * one archiving them to object storage. Entities are named by their entity name, like `User`.
 */
export interface HistoryStore {
  /**
   * Stores the next version of a record, inside the write's transaction (a throw fails the write); resolves the stored
   * version with its number, or nothing.
   */
  write(version: NewVersion, ctx: { entity: string }): HistoryVersion | void | Promise<HistoryVersion | void>;
  /** The versions of a record matching the query's filters, newest first, one page of them, with the total. */
  list(entity: string, id: string, query: VersionQuery): Promise<VersionPage>;
  /** One version of a record, or null. */
  get(entity: string, id: string, version: number): Promise<HistoryVersion | null>;
  /**
   * Deletes the versions of an entity older than `before`; with `keepLatest`, keeps the highest version of each record
   * whose last operation is not `delete`. Resolves how many it deleted.
   */
  prune(entity: string, before: Date, keepLatest: boolean): Promise<number>;
}

/** What `beforeVersion` hooks receive: the entity, the version about to be written (numbered when stored) and its event. */
export interface HistoryVersionStep {
  entity: string;
  version: NewVersion;
  event: WriteEvent;
}

/** What `afterVersion` hooks receive once the write committed: the entity, the stored version and its event. */
export interface HistoryWrittenVersion {
  entity: string;
  version: HistoryVersion | NewVersion;
  event: WriteEvent;
}

/** A per-tenant retention: called when pruning, once per entity and tenant id; undefined keeps the versions forever. */
export type HistoryRetentionFunction = (ctx: { entity: string; tenant: string | undefined }) => string | undefined;

/** The feature API of `history`, reached with `ctx.feature("history")` from a feature that lists it in `requires` or `after`. */
export interface HistoryApi {
  /** Appends a `beforeVersion` hook after the config's; it may return a changed step or null to skip the version. */
  beforeVersion(fn: FeatureHook<HistoryVersionStep | null, undefined>): void;
  /** Appends an `afterVersion` hook after the config's; it observes each version once its write committed. */
  afterVersion(fn: FeatureHook<HistoryWrittenVersion, undefined>): void;
  /** The versions of a record, newest first, read through the store (default limit 20, offset 0). */
  versions(entity: string, id: string, page?: { limit?: number; offset?: number }): Promise<HistoryVersion[]>;
}
