import { HttpError, type FieldErrorDetail } from "../errors.ts";
import { convertQueryValue } from "../query.ts";
import type { Endpoint } from "./server.ts";

export type QueryValueType = { type: "string" | "number" | "boolean" | "date" } | { type: "enum"; values: string[] };

/** One item of an endpoint's typed query: a single value, or an array read from repeated keys. */
export type QueryItem = { name: string; optional: boolean } & (QueryValueType | { type: "array"; items: QueryValueType });

/** Converts and validates the declared items of a query string; undeclared keys are ignored. */
export function parseQueryItems(items: readonly QueryItem[], params: URLSearchParams): Record<string, unknown> {
  const details: FieldErrorDetail[] = [];
  const result: Record<string, unknown> = {};
  const convert = (raw: string, type: QueryValueType, field: string) => {
    const converted = convertQueryValue(raw, type.type, type.type === "enum" ? type.values : undefined);
    if ("error" in converted) details.push({ field, message: converted.error });
    return "error" in converted ? undefined : converted.value;
  };
  for (const item of items) {
    const raws = params.getAll(item.name);
    if (raws.length === 0) {
      if (!item.optional) details.push({ field: item.name, message: "Is required" });
      continue;
    }
    if (item.type === "array") {
      result[item.name] = raws.map((raw, index) => convert(raw, item.items, `${item.name}[${index}]`));
    } else if (raws.length > 1) {
      details.push({ field: item.name, message: "Parameter is repeated" });
    } else {
      result[item.name] = convert(raws[0]!, item, item.name);
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
