import type { StoredRecord } from "./adapter.ts";
import type { EntityModel } from "./model.ts";

/**
 * Why a record changed: `write` for the repository call that named it; `cascade` for a record deleted with it,
 * `setNull` and `pull` for references to a deleted record cleared or removed, and `touch` for a record whose relation
 * side or `updatedAt` changed through relation sync.
 */
export type WriteCause = "write" | "cascade" | "setNull" | "pull" | "touch";

/** One record a repository write created, updated or deleted. */
export interface WriteChange {
  entity: EntityModel;
  operation: "created" | "updated" | "deleted";
  id: string;
  /** The stored record before the write; null for a create, and when no observer of the entity needs it. */
  before: StoredRecord | null;
  /** The stored record after the write; null for a delete. */
  after: StoredRecord | null;
  /** The top-level fields whose stored values differ between `before` and `after`, `updatedAt` excluded. */
  changed: string[];
  cause: WriteCause;
}

/** A value of an observer setting: one answer for every entity, or one per entity. */
type PerEntity = boolean | ((entity: EntityModel) => boolean);

/** Code told about repository writes. */
export interface WriteObserver {
  /** The entities observed: keys, or a function of the model (default: every entity). */
  entities?: readonly string[] | ((entity: EntityModel) => boolean);
  /** Reads `before` inside a transaction with a row lock, so updates and deletes report it. */
  needsBefore?: PerEntity;
  /** Runs `write` inside the write's transaction, so a throw rolls the write back. */
  transactional?: PerEntity;
  /** Called for each change, awaited; inside the write's transaction when there is one. */
  write(change: WriteChange): void | Promise<void>;
}

/** The observers of one entity, with what they need from its writes. */
export interface EntityObservers {
  observers: readonly WriteObserver[];
  /** Whether a write must read `before`, which it does inside a transaction. */
  needsBefore: boolean;
  /** Whether a write must run in a transaction, for `before` or for transactional observers. */
  inTransaction: boolean;
}

const observers: WriteObserver[] = [];
/** The observers of each entity, rebuilt after an observer is added or removed. */
let cache = new WeakMap<EntityModel, EntityObservers | null>();

const answer = (setting: PerEntity | undefined, entity: EntityModel) => (typeof setting === "function" ? setting(entity) : setting === true);

/**
 * Tells `observer` about every successful `create`, `createWith`, `update`, `replace`, `replaceWith` and `delete` of
 * the repositories of the entities it accepts; returns a function that stops it.
 */
export function observeWrites(observer: WriteObserver): () => void {
  observers.push(observer);
  cache = new WeakMap();
  return () => {
    const at = observers.indexOf(observer);
    if (at < 0) return;
    observers.splice(at, 1);
    cache = new WeakMap();
  };
}

/** The observers of `entity`, or null when nothing observes it, so its writes keep their plain statements. */
export function observersOf(entity: EntityModel): EntityObservers | null {
  if (observers.length === 0) return null;
  const cached = cache.get(entity);
  if (cached !== undefined) return cached;
  const accepted = observers.filter((observer) =>
    observer.entities === undefined ? true : typeof observer.entities === "function" ? observer.entities(entity) : observer.entities.includes(entity.key),
  );
  const needsBefore = accepted.some((observer) => answer(observer.needsBefore, entity));
  const result =
    accepted.length === 0 ? null : { observers: accepted, needsBefore, inTransaction: needsBefore || accepted.some((observer) => answer(observer.transactional, entity)) };
  cache.set(entity, result);
  return result;
}

const SKIPPED = new Set(["updatedAt"]);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  return true;
}

/** The top-level fields whose values differ between two stored records (a missing side counts as empty), `updatedAt` excluded. */
export function changedFields(before: StoredRecord | null, after: StoredRecord | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => !SKIPPED.has(key) && !same(before?.[key], after?.[key]));
}

/** Reports one change to every observer of its entity, in registration order, awaiting each. */
export async function reportChange(observed: EntityObservers, change: Omit<WriteChange, "changed"> & { changed?: string[] }): Promise<void> {
  const full: WriteChange = { ...change, changed: change.changed ?? changedFields(change.before, change.after) };
  for (const observer of observed.observers) await observer.write(full);
}
