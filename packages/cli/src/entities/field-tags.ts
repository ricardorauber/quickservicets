import type { FieldModel, NestedFieldModel, StringFormat, TypeDescriptor } from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import type { DocTag } from "./jsdoc.ts";

export interface FieldTagContext {
  relativeFile: string;
  path: string;
  topLevel: boolean;
}

type FieldUnderConstruction = NestedFieldModel & Partial<Pick<FieldModel, "unique" | "index">>;

type FieldTagHandler = (field: FieldUnderConstruction, tag: DocTag, context: FieldTagContext) => void;

const fieldTagHandlers = new Map<string, FieldTagHandler>();

/** Registers a field-level JSDoc tag. Features that add field tags register them here. */
export function registerFieldTag(name: string, handler: FieldTagHandler): void {
  fieldTagHandlers.set(name, handler);
}

export function isFieldTag(name: string): boolean {
  return fieldTagHandlers.has(name);
}

export function fieldTagError(context: FieldTagContext, tag: DocTag, reason: string): EntityParseError {
  return new EntityParseError(`${context.relativeFile}: field "${context.path}" has invalid @${tag.name}: ${reason}`);
}

export function applyFieldTags(field: FieldUnderConstruction, tags: DocTag[], context: FieldTagContext): void {
  for (const tag of tags) {
    const handler = fieldTagHandlers.get(tag.name);
    if (!handler) {
      throw new EntityParseError(`${context.relativeFile}: field "${context.path}" has unknown tag @${tag.name}`);
    }
    handler(field, tag, context);
  }
  assertRange(field, "minLength", "maxLength", context);
  assertRange(field, "min", "max", context);
}

function assertRange(
  field: FieldUnderConstruction,
  minKey: "minLength" | "min",
  maxKey: "maxLength" | "max",
  context: FieldTagContext,
): void {
  const min = field[minKey];
  const max = field[maxKey];
  if (min !== undefined && max !== undefined && min > max) {
    throw new EntityParseError(
      `${context.relativeFile}: field "${context.path}" has @${minKey} ${min} greater than @${maxKey} ${max}`,
    );
  }
}

const isColumnType = (field: FieldUnderConstruction) => field.type !== "array" && field.type !== "object";

function requireNoValue(field: FieldUnderConstruction, tag: DocTag, context: FieldTagContext): void {
  if (tag.text !== "") throw fieldTagError(context, tag, "takes no value");
}

function flagTag(key: "unique" | "index"): FieldTagHandler {
  return (field, tag, context) => {
    requireNoValue(field, tag, context);
    if (!context.topLevel || !isColumnType(field)) {
      throw fieldTagError(context, tag, "only applies to top-level fields that are not arrays or objects");
    }
    field[key] = true;
  };
}

function parseNonNegativeInteger(tag: DocTag, context: FieldTagContext): number {
  if (!/^\d+$/.test(tag.text)) throw fieldTagError(context, tag, "expects a non-negative integer");
  return Number(tag.text);
}

function parseNumber(tag: DocTag, context: FieldTagContext): number {
  const value = Number(tag.text);
  if (tag.text === "" || !Number.isFinite(value)) throw fieldTagError(context, tag, "expects a number");
  return value;
}

function lengthTag(key: "minLength" | "maxLength", arraysOnly = false): FieldTagHandler {
  return (field, tag, context) => {
    const applies = field.type === "array" || (!arraysOnly && field.type === "string");
    if (!applies) {
      throw fieldTagError(context, tag, arraysOnly ? "only applies to array fields" : "only applies to string and array fields");
    }
    field[key] = parseNonNegativeInteger(tag, context);
  };
}

function boundTag(key: "min" | "max"): FieldTagHandler {
  return (field, tag, context) => {
    if (field.type !== "number") throw fieldTagError(context, tag, "only applies to number fields");
    field[key] = parseNumber(tag, context);
  };
}

function parseLiteral(text: string): unknown {
  const quoted = /^'(.*)'$/s.exec(text);
  if (quoted) return quoted[1];
  return JSON.parse(text);
}

export function matchesDescriptor(value: unknown, descriptor: TypeDescriptor): boolean {
  switch (descriptor.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "enum":
      return typeof value === "string" && descriptor.values.includes(value);
    case "array":
      return Array.isArray(value) && value.every((item) => matchesDescriptor(item, descriptor.items));
    case "object":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.entries(value).every(([key, item]) => {
          const nested = descriptor.fields.find((candidate) => candidate.name === key);
          return nested !== undefined && matchesDescriptor(item, nested);
        })
      );
    case "ref":
      return false;
  }
}

registerFieldTag("unique", flagTag("unique"));
registerFieldTag("index", flagTag("index"));
registerFieldTag("default", (field, tag, context) => {
  let value: unknown;
  try {
    value = parseLiteral(tag.text);
  } catch {
    throw fieldTagError(context, tag, `"${tag.text}" is not a valid literal`);
  }
  if (!matchesDescriptor(value, field)) throw fieldTagError(context, tag, `${tag.text} does not match the field type`);
  field.default = value;
});
registerFieldTag("minLength", lengthTag("minLength"));
registerFieldTag("maxLength", lengthTag("maxLength"));
registerFieldTag("minItems", lengthTag("minLength", true));
registerFieldTag("maxItems", lengthTag("maxLength", true));
registerFieldTag("min", boundTag("min"));
registerFieldTag("max", boundTag("max"));
registerFieldTag("format", (field, tag, context) => {
  if (field.type !== "string") throw fieldTagError(context, tag, "only applies to string fields");
  if (tag.text !== "email" && tag.text !== "url") throw fieldTagError(context, tag, "expects email or url");
  field.format = tag.text as StringFormat;
});
registerFieldTag("onDelete", (field, tag, context) => {
  // The value itself is parsed together with the reference; here only applicability is checked.
  if (field.type !== "ref") throw fieldTagError(context, tag, "only applies to reference fields");
});
registerFieldTag("hidden", (field, tag, context) => {
  if (tag.text === "") {
    field.hidden = true;
    return;
  }
  const scope = /^:(\S+)$/.exec(tag.text);
  if (!scope) throw fieldTagError(context, tag, "takes no value, or an operation scope like @hidden:list");
  const operations = scope[1]!.split(",");
  for (const operation of operations) {
    if (operation !== "list" && operation !== "read") {
      throw fieldTagError(context, tag, `unknown operation "${operation}" (use list or read)`);
    }
  }
  field.hiddenOn = [...new Set([...(field.hiddenOn ?? []), ...(operations as ("list" | "read")[])])];
});
