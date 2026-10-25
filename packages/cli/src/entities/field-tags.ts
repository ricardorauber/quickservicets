import { parseSize, type FieldModel, type NestedFieldModel, type StringFormat, type TypeDescriptor, type VectorMetric } from "@quickservice/core";
import { tagDocRegistry } from "../tag-docs.ts";
import { EntityParseError } from "./errors.ts";
import type { DocTag } from "./jsdoc.ts";
import { activeFeatureTags, applyFeatureTag, unknownTagMessage } from "./feature-tags.ts";

export interface FieldTagContext {
  relativeFile: string;
  path: string;
  topLevel: boolean;
}

type FieldUnderConstruction = NestedFieldModel & Partial<Pick<FieldModel, "unique" | "index" | "inverse" | "owner" | "onConflict" | "joinTable" | "fileLimits" | "keepFile" | "vector">>;

type FieldTagHandler = (field: FieldUnderConstruction, tag: DocTag, context: FieldTagContext) => void;

const fieldTagHandlers = new Map<string, FieldTagHandler>();

/** Registers a field-level JSDoc tag. Features that add field tags register them here. */
export function registerFieldTag(name: string, handler: FieldTagHandler): void {
  fieldTagHandlers.set(name, handler);
}

const fieldTagDocs = tagDocRegistry(() => fieldTagHandlers.keys());
/** Documents a field tag for the reference pages. */
export const describeFieldTag = fieldTagDocs.describe;
/** Every registered field tag with its documentation. */
export const documentedFieldTags = fieldTagDocs.list;

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
      const parsed = applyFeatureTag(field.tags, tag, "field", context.relativeFile);
      if (parsed) {
        field.tags = parsed;
        continue;
      }
      const native = activeFeatureTags().disabled.has(tag.name);
      throw new EntityParseError(native ? unknownTagMessage(context.relativeFile, tag.name) : `${context.relativeFile}: field "${context.path}" has unknown tag @${tag.name}`);
    }
    handler(field, tag, context);
  }
  assertRange(field, "minLength", "maxLength", context);
  assertRange(field, "min", "max", context);
  if (field.integer && typeof field.default === "number" && !Number.isInteger(field.default)) {
    throw fieldTagError(context, { name: "integer", text: "" }, `${field.default} is not an integer`);
  }
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

const isColumnType = (field: FieldUnderConstruction) =>
  field.type !== "array" && field.type !== "object" && field.type !== "refArray";

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
    const applies = field.type === "array" || field.type === "refArray" || (!arraysOnly && field.type === "string");
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
    case "json":
      return true;
    case "refArray":
      return Array.isArray(value) && value.length === 0;
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
registerFieldTag("integer", (field, tag, context) => {
  requireNoValue(field, tag, context);
  if (field.type !== "number") throw fieldTagError(context, tag, "only applies to number fields");
  field.integer = true;
});
registerFieldTag("format", (field, tag, context) => {
  if (field.type !== "string") throw fieldTagError(context, tag, "only applies to string fields");
  if (tag.text !== "email" && tag.text !== "url") throw fieldTagError(context, tag, "expects email or url");
  field.format = tag.text as StringFormat;
});
function requireFileReference(field: FieldUnderConstruction, tag: DocTag, context: FieldTagContext): void {
  // Whether the target is a file entity is checked once every entity is parsed.
  if ((field.type !== "ref" && field.type !== "refArray") || !context.topLevel) {
    throw fieldTagError(context, tag, "only applies to references to file entities");
  }
}
registerFieldTag("maxSize", (field, tag, context) => {
  requireFileReference(field, tag, context);
  const size = parseSize(tag.text);
  if (size === undefined) throw fieldTagError(context, tag, "expects a size like 512KB or 10MB");
  field.fileLimits = { ...field.fileLimits, maxSize: size };
});
registerFieldTag("accept", (field, tag, context) => {
  requireFileReference(field, tag, context);
  const patterns = tag.text.split(",").map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
  if (patterns.length === 0 || !patterns.every((pattern) => /^[\w*.+-]+\/[\w*.+-]+$/.test(pattern))) {
    throw fieldTagError(context, tag, "expects MIME patterns like image/png,image/*");
  }
  field.fileLimits = { ...field.fileLimits, accept: patterns };
});
registerFieldTag("maxTotalSize", (field, tag, context) => {
  if (field.type !== "refArray" || !context.topLevel) throw fieldTagError(context, tag, "only applies to arrays of files");
  const size = parseSize(tag.text);
  if (size === undefined) throw fieldTagError(context, tag, "expects a size like 512KB or 10MB");
  field.fileLimits = { ...field.fileLimits, maxTotalSize: size };
});
registerFieldTag("keepFile", (field, tag, context) => {
  requireNoValue(field, tag, context);
  requireFileReference(field, tag, context);
  field.keepFile = true;
});
registerFieldTag("onDelete", (field, tag, context) => {
  // The value itself is parsed together with the reference; here only applicability is checked.
  if (field.type !== "ref" && field.type !== "refArray") throw fieldTagError(context, tag, "only applies to reference fields");
});
registerFieldTag("inverse", (field, tag, context) => {
  if (field.type !== "ref" && field.type !== "refArray") throw fieldTagError(context, tag, "only applies to reference fields");
  if (!/^[A-Za-z_$][\w$]*$/.test(tag.text)) throw fieldTagError(context, tag, "expects a field name or none");
  field.inverse = tag.text;
});
registerFieldTag("owner", (field, tag, context) => {
  requireNoValue(field, tag, context);
  if (field.type !== "ref") throw fieldTagError(context, tag, "only applies to single reference fields");
  field.owner = true;
});
registerFieldTag("joinTable", (field, tag, context) => {
  if (field.type !== "refArray") throw fieldTagError(context, tag, "only applies to reference arrays and N-N relations");
  if (!/^[a-z][a-z0-9_]*$/.test(tag.text)) throw fieldTagError(context, tag, "expects a name matching ^[a-z][a-z0-9_]*$");
  field.joinTable = tag.text;
});
registerFieldTag("onConflict", (field, tag, context) => {
  if (field.type !== "ref") throw fieldTagError(context, tag, "only applies to single reference fields");
  if (tag.text !== "replace") throw fieldTagError(context, tag, "expects replace");
  field.onConflict = "replace";
});
/** Largest vector pgvector stores, and largest one its HNSW index takes. */
export const MAX_VECTOR_DIMENSIONS = 16000;
export const MAX_HNSW_DIMENSIONS = 2000;
const VECTOR_METRICS: VectorMetric[] = ["cosine", "l2", "ip"];

registerFieldTag("vector", (field, tag, context) => {
  if (!context.topLevel || field.type !== "array" || field.items.type !== "number") {
    throw new EntityParseError(`${context.relativeFile}: @vector needs a number[] field`);
  }
  const [shorthand, ...options] = tag.text.split(/\s+/).filter((part) => part !== "");
  if (!shorthand || !/^\d+$/.test(shorthand) || Number(shorthand) < 1 || Number(shorthand) > MAX_VECTOR_DIMENSIONS) {
    throw fieldTagError(context, tag, `expects the dimensions, an integer from 1 to ${MAX_VECTOR_DIMENSIONS}`);
  }
  const vector: NonNullable<FieldModel["vector"]> = { dimensions: Number(shorthand), metric: "cosine", index: "none" };
  for (const option of options) {
    const [key, value] = option.split("=", 2);
    if (key === "metric" && VECTOR_METRICS.includes(value as VectorMetric)) vector.metric = value as VectorMetric;
    else if (key === "index" && (value === "none" || value === "hnsw")) vector.index = value;
    else if (key === "metric") throw fieldTagError(context, tag, `metric expects ${VECTOR_METRICS.join(", ")}`);
    else if (key === "index") throw fieldTagError(context, tag, "index expects none or hnsw");
    else throw fieldTagError(context, tag, `unknown option "${option}" (use metric= or index=)`);
  }
  if (vector.index === "hnsw" && vector.dimensions > MAX_HNSW_DIMENSIONS) {
    throw new EntityParseError(`${context.relativeFile}: @vector index=hnsw supports at most ${MAX_HNSW_DIMENSIONS} dimensions`);
  }
  field.vector = vector;
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

describeFieldTag("unique", {
  description: "Rejects a value that another record already has, with 409 `Value already exists`.",
  appliesTo: "Top-level fields that are not arrays or objects",
  example: "/** @unique */ email: string",
});
describeFieldTag("index", {
  description: "Creates a database index on the field, for faster filters and sorting.",
  appliesTo: "Top-level fields that are not arrays or objects",
  example: "/** @index */ country: string",
});
describeFieldTag("default", {
  description: "Value used when a create body leaves the field out; enum fields also accept `Enum.member`.",
  appliesTo: "Any field",
  example: "/** @default 'member' */ role: \"member\" | \"admin\"",
});
describeFieldTag("minLength", {
  description: "Minimum length of a string (`Must be at least <n> characters`); on arrays, the minimum number of items.",
  appliesTo: "Strings and arrays",
  example: "/** @minLength 2 */ name: string",
});
describeFieldTag("maxLength", {
  description: "Maximum length of a string; on arrays, the maximum number of items.",
  appliesTo: "Strings and arrays",
  example: "/** @maxLength 80 */ title: string",
});
describeFieldTag("minItems", {
  description: "Minimum number of items (`Must have at least <n> items`).",
  appliesTo: "Arrays and reference arrays",
  example: "/** @minItems 1 */ tags: string[]",
});
describeFieldTag("maxItems", {
  description: "Maximum number of items (`Must have at most <n> items`).",
  appliesTo: "Arrays and reference arrays",
  example: "/** @maxItems 10 */ members: User[]",
});
describeFieldTag("min", {
  description: "Smallest accepted number (`Must be at least <n>`).",
  appliesTo: "Numbers",
  example: "/** @min 0 */ age: number",
});
describeFieldTag("max", {
  description: "Largest accepted number (`Must be at most <n>`).",
  appliesTo: "Numbers",
  example: "/** @max 150 */ age: number",
});
describeFieldTag("integer", {
  description: "Accepts only whole numbers (`Must be an integer`); the API docs show `type: integer`. Also applies to number query items of custom endpoints.",
  appliesTo: "Numbers (entity fields and query items, arrays of numbers included on query items)",
  example: "/** @integer @min 0 */ stock: number",
});
describeFieldTag("format", {
  description: "Checks that a string is an `email` or a `url`.",
  appliesTo: "Strings",
  example: "/** @format email */ email: string",
});
describeFieldTag("maxSize", {
  description: "Largest file this field accepts, on top of the file entity's own limit.",
  appliesTo: "References and reference arrays to file entities",
  example: "/** @maxSize 1MB */ logo?: Media",
});
describeFieldTag("accept", {
  description: "MIME patterns this field accepts, on top of the file entity's own rules.",
  appliesTo: "References and reference arrays to file entities",
  example: "/** @accept image/png,image/webp */ logo?: Media",
});
describeFieldTag("maxTotalSize", {
  description: "Largest total size of the files uploaded to the field in one request.",
  appliesTo: "Reference arrays to file entities",
  example: "/** @maxTotalSize 10MB */ gallery?: Media[]",
});
describeFieldTag("keepFile", {
  description: "Never deletes the referenced file when it is replaced or when this record is deleted.",
  appliesTo: "References and reference arrays to file entities",
  example: "/** @keepFile */ contract?: File",
});
describeFieldTag("onDelete", {
  description: "What happens to this record when the referenced record is deleted: `restrict` (default), `cascade` or `setNull`; arrays take `pull` (default), `restrict` or `cascade`.",
  appliesTo: "References and reference arrays",
  example: "/** @onDelete cascade */ organization: Organization",
});
describeFieldTag("inverse", {
  description: "Pairs the field with a field of the referenced entity into one relation; `@inverse none` keeps them apart.",
  appliesTo: "References and reference arrays",
  example: "/** @inverse members */ organization: Organization",
});
describeFieldTag("owner", {
  description: "Marks the side of a 1-1 relation that stores the reference.",
  appliesTo: "Single references in a 1-1 relation",
  example: "/** @owner */ profile: Profile",
});
describeFieldTag("joinTable", {
  description: "Names the junction table (or join collection) of a reference array or N-N relation.",
  appliesTo: "Reference arrays",
  example: "/** @joinTable team_members */ users: User[]",
});
describeFieldTag("onConflict", {
  description: "With `replace`, linking a 1-1 target that is already linked moves the link instead of failing with 409.",
  appliesTo: "Single references in a 1-1 relation",
  example: "/** @onConflict replace */ badge: Badge",
});
describeFieldTag("vector", {
  description:
    "Stores embeddings of `<dimensions>` numbers (1 to 16000): a pgvector `vector` column on PostgreSQL, a number array elsewhere. Writes need exactly that many numbers (`Must be a list of <n> numbers`); list and read routes return the field only when `fields` selects it, and it cannot be filtered or sorted. Options: `metric=cosine|l2|ip` (default `cosine`) and `index=none|hnsw` (default `none`; `hnsw` builds an approximate index on PostgreSQL, up to 2000 dimensions).",
  appliesTo: "Top-level `number[]` fields",
  example: "/** @vector 1536 index=hnsw */ embedding?: number[]",
});
describeFieldTag("hidden", {
  description: "Never returns the field in responses; `@hidden:list` or `@hidden:read` hides it only there.",
  appliesTo: "Any field",
  example: "/** @hidden */ passwordHash: string",
});
