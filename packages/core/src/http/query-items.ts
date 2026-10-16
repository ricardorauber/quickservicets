import { HttpError, type FieldErrorDetail } from "../errors.ts";
import { convertQueryValue } from "../query.ts";
import type { Endpoint } from "./server.ts";

/** `enumName` is the enum or alias an enum item uses, when it has one. */
export type QueryValueType = { type: "string" | "number" | "boolean" | "date" } | { type: "enum"; values: string[]; enumName?: string };

/** `@min`/`@max` (numbers) and `@minLength`/`@maxLength` (strings), checked on each value. */
export interface QueryItemLimits {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

/**
 * One item of an endpoint's typed query: a single value, or an array read from repeated keys. `default` is used when
 * the item is absent (dates as ISO 8601 strings).
 */
export type QueryItem = { name: string; optional: boolean; default?: unknown; limits?: QueryItemLimits } & (
  | QueryValueType
  | { type: "array"; items: QueryValueType }
);

function limitError(value: unknown, limits: QueryItemLimits | undefined): string | undefined {
  if (!limits) return undefined;
  if (typeof value === "number") {
    if (limits.min !== undefined && value < limits.min) return `Must be at least ${limits.min}`;
    if (limits.max !== undefined && value > limits.max) return `Must be at most ${limits.max}`;
  }
  if (typeof value === "string") {
    if (limits.minLength !== undefined && value.length < limits.minLength) return `Must be at least ${limits.minLength} characters`;
    if (limits.maxLength !== undefined && value.length > limits.maxLength) return `Must be at most ${limits.maxLength} characters`;
  }
  return undefined;
}

function defaultValue(item: QueryItem): unknown {
  const type = item.type === "array" ? item.items.type : item.type;
  const toValue = (value: unknown) => (type === "date" && typeof value === "string" ? new Date(value) : structuredClone(value));
  return Array.isArray(item.default) ? item.default.map(toValue) : toValue(item.default);
}

/** Converts and validates the declared items of a query string; undeclared keys are ignored. */
export function parseQueryItems(items: readonly QueryItem[], params: URLSearchParams): Record<string, unknown> {
  const details: FieldErrorDetail[] = [];
  const result: Record<string, unknown> = {};
  const convert = (raw: string, type: QueryValueType, field: string, limits: QueryItemLimits | undefined) => {
    const converted = convertQueryValue(raw, type.type, type.type === "enum" ? type.values : undefined);
    const error = "error" in converted ? converted.error : limitError(converted.value, limits);
    if (error) details.push({ field, message: error });
    return "error" in converted ? undefined : converted.value;
  };
  for (const item of items) {
    const raws = params.getAll(item.name);
    if (raws.length === 0) {
      if (item.default !== undefined) result[item.name] = defaultValue(item);
      else if (!item.optional) details.push({ field: item.name, message: "Is required" });
      continue;
    }
    if (item.type === "array") {
      result[item.name] = raws.map((raw, index) => convert(raw, item.items, `${item.name}[${index}]`, item.limits));
    } else if (raws.length > 1) {
      details.push({ field: item.name, message: "Parameter is repeated" });
    } else {
      result[item.name] = convert(raws[0]!, item, item.name, item.limits);
    }
  }
  if (details.length > 0) throw new HttpError(400, "Invalid query", { details });
  return result;
}

/** Sets `req.queryItems` from the query string before the handler runs. */
export function withQueryItems(handler: Endpoint, items: readonly QueryItem[] | undefined): Endpoint {
  if (!items || items.length === 0) return handler;
  return (repos, req, res) => {
    (req as { queryItems: unknown }).queryItems = parseQueryItems(items, req.query);
    return handler(repos, req, res);
  };
}
