import { sql, type SQL } from "drizzle-orm";
import type { Aggregate } from "../adapter.ts";
import type { SqlDialect } from "./schema.ts";
import { toWhere, type RelationContext } from "./conditions.ts";

// Drizzle columns are looked up by field name on dynamically built tables.
type Columns = Record<string, unknown>;

/**
 * The select list of an aggregate statement: one expression per aggregate, decoded to numbers, or to the column's
 * values for `min` and `max` (so dates come back as dates).
 */
export function aggregateSelection(
  table: Columns,
  aggregates: Record<string, Aggregate>,
  dialect: SqlDialect,
  context?: RelationContext,
): Record<string, SQL> {
  const selection: Record<string, SQL> = {};
  for (const [name, aggregate] of Object.entries(aggregates)) {
    if (aggregate.fn === "count") {
      const condition = toWhere(table, aggregate.where ?? [], dialect, context);
      selection[name] = (condition ? sql`count(*) filter (where ${condition})` : sql`count(*)`).mapWith(Number);
      continue;
    }
    const target = table[aggregate.field];
    if (target === undefined) throw new Error(`Unknown column for field "${aggregate.field}"`);
    const expression = sql`${sql.raw(aggregate.fn)}(${target})`;
    selection[name] = aggregate.fn === "sum" || aggregate.fn === "avg" ? expression.mapWith(Number) : expression.mapWith(target as never);
  }
  return selection;
}
