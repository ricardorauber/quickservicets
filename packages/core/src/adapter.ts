import type { EntityModel } from "./model.ts";
import type { Condition, SortField } from "./query.ts";

/** A record as stored by an adapter: the entity fields plus the system fields. */
export type StoredRecord = Record<string, unknown> & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface FindManyOptions {
  where: Condition[];
  sort: SortField[];
  limit: number;
  offset: number;
  /** False skips counting the matches; `total` is then the number of records returned (default true). */
  withTotal?: boolean;
}

export interface FindManyResult {
  data: StoredRecord[];
  total: number;
}

/**
 * One aggregate computed by `DatabaseAdapter.aggregate`: the number of matches (only those that also satisfy `where`,
 * when given), or a function over a number or date field.
 */
export type Aggregate =
  | { fn: "count"; where?: Condition[] }
  | { fn: "sum" | "avg" | "min" | "max"; field: string };

/** Aggregate results by name: counts are numbers, the others numbers or dates, or null without values. */
export type AggregateValues = Record<string, number | Date | null>;

/** A reference array, field `field` of `owner`, from which a delete removes the deleted record's id. */
export interface ReferencePull {
  owner: EntityModel;
  field: string;
}

export type AdapterKind = "memory" | "sqlite" | "postgres" | "mongodb";

export interface ConnectOptions {
  /** The resolved default schema (see `loadConfig`), or null for the database's own default. */
  defaultSchema?: string | null;
  /** The server processes sharing the adapter's connection pool size, each opening its share (default 1). */
  workers?: number;
}

export interface DatabaseAdapter {
  /** Identifies built-in adapters, so tools such as migrations know the database dialect. */
  readonly kind?: AdapterKind;
  connect(models: EntityModel[], options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  findById(entity: EntityModel, id: string): Promise<StoredRecord | null>;
  findOne(entity: EntityModel, where: Condition[]): Promise<StoredRecord | null>;
  findMany(entity: EntityModel, options: FindManyOptions): Promise<FindManyResult>;
  /** Stores a new record and resolves the record as stored. */
  insert(entity: EntityModel, record: StoredRecord): Promise<StoredRecord>;
  /**
   * Updates the record with that id; with `where`, only when the record also matches those conditions, checked in the
   * same atomic write. Resolves the record as stored after the update, or null when no record was updated.
   */
  updateById(entity: EntityModel, id: string, changes: Record<string, unknown>, where?: Condition[]): Promise<StoredRecord | null>;
  deleteById(entity: EntityModel, id: string): Promise<boolean>;
  /**
   * Deletes the record with that id and, in the same atomic write, removes its id from the junction-stored reference
   * arrays `pulls` without rewriting their other items. Every record that held the id gets `updatedAt`, or 1 ms after
   * its stored `updatedAt` when that is not earlier. Resolves false when no record was deleted. Optional: without it,
   * a delete rewrites each reference array that held the id.
   */
  deleteAndPull?(entity: EntityModel, id: string, pulls: ReferencePull[], updatedAt: Date): Promise<boolean>;
  count(entity: EntityModel, where: Condition[]): Promise<number>;
  /**
   * Computes every aggregate over the records matching `where` in one statement (or pipeline). Counts are 0 and the
   * other aggregates null when no record has a value.
   */
  aggregate(entity: EntityModel, where: Condition[], aggregates: Record<string, Aggregate>): Promise<AggregateValues>;
  /** Runs `fn` atomically when the database supports transactions, or directly otherwise. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Locks a record until the current transaction ends, for read-modify-write updates (optional). */
  lockForUpdate?(entity: EntityModel, id: string): Promise<void>;
}

const FIND_ALL_BATCH = 1000;

/** Every record matching `where`, read in pages without counting the matches first. */
export async function findAll(adapter: DatabaseAdapter, entity: EntityModel, where: Condition[], sort: SortField[]): Promise<StoredRecord[]> {
  // A unique last sort key keeps the pages from overlapping.
  const order: SortField[] = sort.some((item) => item.field === "id") ? sort : [...sort, { field: "id", direction: "asc" }];
  const found: StoredRecord[] = [];
  for (let offset = 0; ; offset += FIND_ALL_BATCH) {
    const { data } = await adapter.findMany(entity, { where, sort: order, limit: FIND_ALL_BATCH, offset, withTotal: false });
    found.push(...data);
    if (data.length < FIND_ALL_BATCH) return found;
  }
}

export class UniqueViolationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Unique constraint violated on "${field}"`);
    this.name = "UniqueViolationError";
    this.field = field;
  }
}
