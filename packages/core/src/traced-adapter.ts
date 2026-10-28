import type { DatabaseAdapter, RelatedScope } from "./adapter.ts";
import type { EntityModel } from "./model.ts";
import { spanAttributes, startSpan, tracingEnabled, withSpan } from "./tracing.ts";
import { coreInstruments, metricsEnabled, tenantAttributes, type MetricAttributes } from "./metering.ts";
import { currentTenant } from "./database-scope.ts";

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
 * `<operation> <collection>` while a tracer is set, with the database semantic attributes and never the statement or
 * its values, and record `db.client.operation.duration` while a meter is set. It shares the adapter's connection and
 * transactions; repositories use it while either is set.
 */
export function tracedAdapter(adapter: DatabaseAdapter): DatabaseAdapter {
  const system = SYSTEMS[adapter.kind ?? "memory"] ?? String(adapter.kind);
  /** Records the call's duration as `db.client.operation.duration`, with its error type when it fails. */
  const measure = async (entity: EntityModel, operation: string, call: () => Promise<unknown>) => {
    const started = performance.now();
    const attributes: MetricAttributes = { "db.system.name": system, "db.operation.name": operation, "db.collection.name": entity.name };
    try {
      return await call();
    } catch (error) {
      attributes["error.type"] = errorType(error);
      throw error;
    } finally {
      coreInstruments().databaseDuration.record((performance.now() - started) / 1000, { ...attributes, ...tenantAttributes(currentTenant()?.id) });
    }
  };
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
          const call = () => (value as (...args: unknown[]) => Promise<unknown>).call(target, first, ...rest);
          const measured = metricsEnabled() ? () => measure(entity, String(property), call) : call;
          if (!tracingEnabled()) return measured();
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
              const result = await measured();
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
