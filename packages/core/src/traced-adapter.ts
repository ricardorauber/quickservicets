import type { DatabaseAdapter, RelatedScope } from "./adapter.ts";
import type { EntityModel } from "./model.ts";
import { spanAttributes, startSpan, withSpan } from "./tracing.ts";

/** The `db.system.name` of each adapter kind. */
const SYSTEMS: Record<string, string> = { postgres: "postgresql", sqlite: "sqlite", mongodb: "mongodb", memory: "memory" };

/** The adapter calls that read, write or aggregate records, with how many rows a read returned. */
const OPERATIONS: Record<string, { scope?: boolean; rows?: (result: unknown) => number }> = {
  findById: { rows: (result) => (result ? 1 : 0) },
  findOne: { rows: (result) => (result ? 1 : 0) },
  findMany: { rows: (result) => (result as { data: unknown[] }).data.length },
  count: {},
  aggregate: {},
  insert: {},
  updateById: {},
  deleteById: {},
  increment: {},
  insertOrSkip: {},
  deleteAndPull: {},
  findRelated: { scope: true, rows: (result) => (result as { data: unknown[] }).data.length },
  countRelated: { scope: true },
  aggregateRelated: { scope: true },
};

/** The error type a failed database call records. */
function errorType(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "Error";
}

/**
 * A view of `adapter` whose record reads, writes and aggregates each run in a `client` span named
 * `<operation> <collection>`, with the database semantic attributes and never the statement or its values. It shares
 * the adapter's connection and transactions; repositories use it while a tracer is set.
 */
export function tracedAdapter(adapter: DatabaseAdapter): DatabaseAdapter {
  const system = SYSTEMS[adapter.kind ?? "memory"] ?? String(adapter.kind);
  const wrapped = new Map<PropertyKey, unknown>();
  const view: DatabaseAdapter = new Proxy(adapter, {
    get(target, property) {
      if (property === "sharesConnectionWith") {
        return (other: DatabaseAdapter) => other === target || other === view || target.sharesConnectionWith?.(other) === true;
      }
      const value = Reflect.get(target, property, target);
      const operation = typeof property === "string" ? OPERATIONS[property] : undefined;
      if (!operation || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      let traced = wrapped.get(property);
      if (!traced) {
        traced = (first: EntityModel | RelatedScope, ...rest: unknown[]) => {
          const entity = operation.scope ? (first as RelatedScope).target : (first as EntityModel);
          const span = startSpan(`${String(property)} ${entity.name}`, {
            kind: "client",
            attributes: spanAttributes({
              "db.system.name": system,
              "db.collection.name": entity.name,
              "db.operation.name": String(property),
              "db.namespace": entity.schema ?? adapter.namespace,
              "quickservicets.entity": entity.key,
            }),
          });
          return withSpan(span, async () => {
            try {
              const result = await (value as (...args: unknown[]) => Promise<unknown>).call(target, first, ...rest);
              if (operation.rows && result !== null && result !== undefined) span.setAttribute("db.response.returned_rows", operation.rows(result));
              else if (operation.rows) span.setAttribute("db.response.returned_rows", 0);
              return result;
            } catch (error) {
              span.setAttribute("error.type", errorType(error));
              span.setStatus("error");
              throw error;
            } finally {
              span.end();
            }
          });
        };
        wrapped.set(property, traced);
      }
      return traced;
    },
  });
  return view;
}
