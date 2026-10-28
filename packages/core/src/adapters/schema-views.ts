import type { DatabaseAdapter, ReferencePull, RelatedScope } from "../adapter.ts";
import type { EntityModel } from "../model.ts";

/** The names `withSchema` accepts; hyphens are stored as underscores. */
export const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

/** Most views one adapter keeps; asking for another evicts the least recently used idle one. */
export const MAX_SCHEMA_VIEWS = 1000;

export const VIEW_CONNECT_MESSAGE = "Connect the parent adapter; withSchema returns a view";

/** Throws unless `schema` is a valid schema name. */
export function assertSchemaName(schema: string): void {
  if (typeof schema !== "string" || !SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema: "${String(schema)}" must match ^[a-z][a-z0-9-]*$`);
}

/** The views of one adapter: one per schema, the least recently used idle one evicted beyond `MAX_SCHEMA_VIEWS`. */
export interface SchemaViews<A extends DatabaseAdapter> {
  /** The view of `schema`, created on first use. */
  get(schema: string): A;
  /** Whether `adapter` is a view this adapter created. */
  owns(adapter: DatabaseAdapter): boolean;
  /** How many views are kept. */
  readonly size: number;
}

/**
 * Keeps the views of `parent`. `create` builds the view of a schema with the parent's connection; the view gets the
 * parent's `kind`, throws from `connect` and `disconnect`, answers `withSchema` with the parent's views and shares its
 * connection with the parent and its other views. A view is idle while none of its calls (transactions included) runs.
 */
export function schemaViews<A extends DatabaseAdapter>(parent: () => A, create: (schema: string) => Partial<A>): SchemaViews<A> {
  const views = new Map<string, A>();
  const created = new WeakSet<DatabaseAdapter>();
  const busy = new WeakMap<DatabaseAdapter, number>();
  const evict = () => {
    for (const [schema, view] of views) {
      if ((busy.get(view) ?? 0) > 0) continue;
      views.delete(schema);
      return;
    }
  };
  const build = (schema: string): A => {
    const view = create(schema) as A & Record<string, unknown>;
    const fail = () => Promise.reject(new Error(VIEW_CONNECT_MESSAGE));
    const shared = {
      connect: fail,
      disconnect: fail,
      withSchema: (other: string) => parent().withSchema!(other),
      sharesConnectionWith: (other: DatabaseAdapter) => other === parent() || created.has(other),
    };
    for (const [key, value] of Object.entries(shared)) Object.defineProperty(view, key, { value, enumerable: true, writable: true, configurable: true });
    // Every call counts as activity until it settles, so eviction never drops a view in use.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(view))) {
      const fn = descriptor.value;
      if (typeof fn !== "function" || key === "withSchema" || key === "sharesConnectionWith") continue;
      (view as Record<string, unknown>)[key] = (...args: unknown[]) => {
        busy.set(view, (busy.get(view) ?? 0) + 1);
        const done = () => busy.set(view, (busy.get(view) ?? 1) - 1);
        try {
          const result = fn.apply(view, args);
          if (result instanceof Promise) return result.finally(done);
          done();
          return result;
        } catch (error) {
          done();
          throw error;
        }
      };
    }
    created.add(view);
    return view;
  };
  return {
    get(schema) {
      assertSchemaName(schema);
      const found = views.get(schema);
      if (found) {
        views.delete(schema);
        views.set(schema, found);
        return found;
      }
      if (views.size >= MAX_SCHEMA_VIEWS) evict();
      const view = build(schema);
      views.set(schema, view);
      return view;
    },
    owns: (adapter) => created.has(adapter),
    get size() {
      return views.size;
    },
  };
}

/**
 * A view that places the default-schema entities in `schema` by handing the parent a copy of each such model with that
 * schema; models with an explicit schema pass unchanged. The copies are made once per model and kept in the view.
 */
export function placedView(parent: DatabaseAdapter, schema: string): DatabaseAdapter {
  const placed = new WeakMap<EntityModel, EntityModel>();
  const place = (entity: EntityModel): EntityModel => {
    // Explicit schemas and the entities every tenant shares stay where the parent keeps them.
    if (entity.schema || entity.tenancy === "shared") return entity;
    let copy = placed.get(entity);
    if (!copy) {
      copy = { ...entity, schema };
      placed.set(entity, copy);
    }
    return copy;
  };
  const related = (scope: RelatedScope): RelatedScope => ({ ...scope, owner: place(scope.owner), target: place(scope.target) });
  const pulls = (list: ReferencePull[]): ReferencePull[] => list.map((pull) => ({ ...pull, owner: place(pull.owner) }));
  const view: DatabaseAdapter = {
    ...(parent.kind ? { kind: parent.kind } : {}),
    namespace: schema,
    get supportsRollback() {
      return parent.supportsRollback;
    },
    connect: () => Promise.reject(new Error(VIEW_CONNECT_MESSAGE)),
    disconnect: () => Promise.reject(new Error(VIEW_CONNECT_MESSAGE)),
    findById: (entity, id, options) => parent.findById(place(entity), id, options),
    findOne: (entity, where) => parent.findOne(place(entity), where),
    findMany: (entity, options) => parent.findMany(place(entity), options),
    insert: (entity, record) => parent.insert(place(entity), record),
    updateById: (entity, id, changes, where) => parent.updateById(place(entity), id, changes, where),
    deleteById: (entity, id) => parent.deleteById(place(entity), id),
    count: (entity, where) => parent.count(place(entity), where),
    aggregate: (entity, where, aggregates) => parent.aggregate(place(entity), where, aggregates),
    transaction: (fn) => parent.transaction(fn),
  };
  if (parent.increment) view.increment = (entity, id, amounts, insert) => parent.increment!(place(entity), id, amounts, insert);
  if (parent.insertOrSkip) view.insertOrSkip = (entity, record, unique) => parent.insertOrSkip!(place(entity), record, unique);
  if (parent.deleteAndPull) view.deleteAndPull = (entity, id, list, at) => parent.deleteAndPull!(place(entity), id, pulls(list), at);
  if (parent.findRelated) view.findRelated = (scope, options) => parent.findRelated!(related(scope), options);
  if (parent.countRelated) view.countRelated = (scope, where) => parent.countRelated!(related(scope), where);
  if (parent.aggregateRelated) view.aggregateRelated = (scope, where, aggregates) => parent.aggregateRelated!(related(scope), where, aggregates);
  if (parent.ping) view.ping = () => parent.ping!();
  if (parent.lockForUpdate) view.lockForUpdate = (entity, id) => parent.lockForUpdate!(place(entity), id);
  return Object.assign(view, { placed: place });
}
