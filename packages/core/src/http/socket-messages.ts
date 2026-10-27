import type { MessageValidator } from "./socket.ts";

/** The JSON schema of a socket's messages, as the build writes it: the schema and the component schemas it references. */
export interface MessageSchema {
  schema: Record<string, unknown>;
  /** Component schemas by name, for `$ref: "#/components/schemas/<name>"`. */
  definitions?: Record<string, Record<string, unknown>>;
}

type Issue = { path: string; message: string };
/** A compiled check: true when the value matches, without allocating. */
type Check = (value: unknown) => boolean;
/** The detailed check, run only for a value that failed, collecting each problem with its path. */
type Explain = (value: unknown, path: string, issues: Issue[]) => void;

interface Compiled {
  check: Check;
  explain: Explain;
}

const join = (path: string, key: string | number) => (path === "" ? String(key) : `${path}.${key}`);
const typeName = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Compiles the subset of JSON schema the build writes for TypeScript types into allocation-free checks. */
function compile(schema: Record<string, unknown>, definitions: Record<string, Record<string, unknown>>, cache: Map<string, Compiled>): Compiled {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    let compiled = cache.get(name);
    if (!compiled) {
      // A placeholder first, so recursive schemas compile.
      const slot: Compiled = { check: (value) => target.check(value), explain: (value, path, issues) => target.explain(value, path, issues) };
      cache.set(name, slot);
      const definition = definitions[name];
      const target = definition ? compile(definition, definitions, cache) : { check: () => true, explain: () => {} };
      compiled = slot;
    }
    return compiled;
  }
  const members = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(members)) {
    const compiled = members.map((member) => compile(member, definitions, cache));
    return {
      check: (value) => compiled.some((member) => member.check(value)),
      explain: (value, path, issues) => {
        issues.push({ path, message: "Must match one of the expected shapes" });
      },
    };
  }
  const parts: Compiled[] = [];
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    parts.push({ check: (value) => values.includes(value), explain: (value, path, issues) => void issues.push({ path, message: `Must be one of ${values.map((item) => JSON.stringify(item)).join(", ")}` }) });
  }
  if (schema.const !== undefined) {
    const expected = schema.const;
    parts.push({ check: (value) => value === expected, explain: (_value, path, issues) => void issues.push({ path, message: `Must be ${JSON.stringify(expected)}` }) });
  }
  const types = schema.type === undefined ? undefined : ([] as string[]).concat(schema.type as string | string[]);
  if (types) {
    const matches = (value: unknown) =>
      types.some((type) =>
        type === "integer"
          ? Number.isInteger(value)
          : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : type === "null"
              ? value === null
              : type === "array"
                ? Array.isArray(value)
                : type === "object"
                  ? typeof value === "object" && value !== null && !Array.isArray(value)
                  : typeof value === type,
      );
    parts.push({ check: matches, explain: (value, path, issues) => void issues.push({ path, message: `Must be ${types.join(" or ")}, got ${typeName(value)}` }) });
  }
  if (schema.format === "date-time") {
    const date = (value: unknown) => typeof value !== "string" || !Number.isNaN(Date.parse(value));
    parts.push({ check: date, explain: (_value, path, issues) => void issues.push({ path, message: "Must be a date-time" }) });
  }
  if (schema.items && typeof schema.items === "object") {
    const item = compile(schema.items as Record<string, unknown>, definitions, cache);
    parts.push({
      check: (value) => !Array.isArray(value) || value.every((entry) => item.check(entry)),
      explain: (value, path, issues) => {
        if (!Array.isArray(value)) return;
        value.forEach((entry, index) => {
          if (!item.check(entry)) item.explain(entry, join(path, index), issues);
        });
      },
    });
  }
  if (schema.properties && typeof schema.properties === "object") {
    const properties = Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([key, child]) => [key, compile(child, definitions, cache)] as const);
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    parts.push({
      check: (value) => {
        if (!isObject(value)) return true;
        for (const [key, child] of properties) {
          const entry = value[key];
          if (entry === undefined) {
            if (required.has(key)) return false;
            continue;
          }
          if (!child.check(entry)) return false;
        }
        return true;
      },
      explain: (value, path, issues) => {
        if (!isObject(value)) return;
        for (const [key, child] of properties) {
          const entry = value[key];
          if (entry === undefined) {
            if (required.has(key)) issues.push({ path: join(path, key), message: "Is required" });
          } else if (!child.check(entry)) child.explain(entry, join(path, key), issues);
        }
      },
    });
  }
  return {
    check: (value) => {
      for (const part of parts) if (!part.check(value)) return false;
      return true;
    },
    explain: (value, path, issues) => {
      for (const part of parts) {
        if (part.check(value)) continue;
        part.explain(value, path, issues);
        // A value that is not an object has nothing more to report.
        if (typeof value !== "object" || value === null) return;
      }
    },
  };
}

/** The `type` constant of an object schema, when it has one. */
function typeConstant(schema: Record<string, unknown>, definitions: Record<string, Record<string, unknown>>): string | undefined {
  const resolved = typeof schema.$ref === "string" ? definitions[schema.$ref.replace("#/components/schemas/", "")] : schema;
  const type = (resolved?.properties as Record<string, Record<string, unknown>> | undefined)?.type;
  if (!type) return undefined;
  if (typeof type.const === "string") return type.const;
  if (Array.isArray(type.enum) && type.enum.length === 1 && typeof type.enum[0] === "string") return type.enum[0];
  return undefined;
}

/**
 * Compiles the schema of a socket's incoming messages into a validator: one call per message, which allocates
 * nothing for a valid one. A union discriminated by a string `type` also gets one validator per type.
 */
export function compileMessageValidator(input: MessageSchema): MessageValidator {
  const definitions = input.definitions ?? {};
  const cache = new Map<string, Compiled>();
  const toValidator = (compiled: Compiled) => (value: unknown) => {
    if (compiled.check(value)) return undefined;
    const issues: Issue[] = [];
    compiled.explain(value, "", issues);
    return issues.length > 0 ? issues : [{ path: "", message: "Does not match the expected shape" }];
  };
  const root = compile(input.schema, definitions, cache);
  const members = (input.schema.anyOf ?? input.schema.oneOf) as Record<string, unknown>[] | undefined;
  const singles = !Array.isArray(members) && typeConstant(input.schema, definitions) !== undefined ? [input.schema] : undefined;
  const variants = Array.isArray(members) ? members : singles;
  let byType: Map<string, (value: unknown) => Issue[] | undefined> | undefined;
  if (variants && variants.every((member) => typeConstant(member, definitions) !== undefined)) {
    byType = new Map(variants.map((member) => [typeConstant(member, definitions)!, toValidator(compile(member, definitions, cache))]));
  }
  return { validate: toValidator(root), ...(byType ? { byType } : {}) };
}
