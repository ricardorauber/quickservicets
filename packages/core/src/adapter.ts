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
}

export interface FindManyResult {
  data: StoredRecord[];
  total: number;
}

export interface DatabaseAdapter {
  connect(models: EntityModel[]): Promise<void>;
  disconnect(): Promise<void>;
  insert(entity: EntityModel, record: StoredRecord): Promise<StoredRecord>;
  findById(entity: EntityModel, id: string): Promise<StoredRecord | null>;
  findOne(entity: EntityModel, where: Condition[]): Promise<StoredRecord | null>;
  findMany(entity: EntityModel, options: FindManyOptions): Promise<FindManyResult>;
  updateById(entity: EntityModel, id: string, changes: Record<string, unknown>): Promise<boolean>;
  deleteById(entity: EntityModel, id: string): Promise<boolean>;
  count(entity: EntityModel, where: Condition[]): Promise<number>;
  /** Runs `fn` atomically when the database supports transactions, or directly otherwise. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export class UniqueViolationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Unique constraint violated on "${field}"`);
    this.name = "UniqueViolationError";
    this.field = field;
  }
}
