import { CRUD_OPERATIONS, parseSize, type CrudOperation, type EntityModel, type HookReference } from "@quickservice/core";
import { tagDocRegistry } from "../tag-docs.ts";
import { EntityParseError } from "./errors.ts";
import type { DocTag } from "./jsdoc.ts";
import { applyFeatureTag } from "./feature-tags.ts";

export interface FieldSelectionTag {
  operations: ("list" | "read")[];
  paths: string;
}

export type EntityTagTarget = Pick<EntityModel, "hooks" | "overrideHooks" | "internal" | "populate" | "storageName" | "fileLimits" | "fileAccess" | "tags"> & {
  /** `@fields` whitelists, validated once the fields are parsed. */
  fieldSelections?: FieldSelectionTag[];
};

export interface EntityTagContext {
  relativeFile: string;
}

type EntityTagHandler = (entity: EntityTagTarget, tag: DocTag, context: EntityTagContext) => void;

const builtInEntityTags = new Map<string, EntityTagHandler>();

/** Registers a built-in entity-level JSDoc tag. Every other entity tag is read as a hook reference. */
export function registerEntityTag(name: string, handler: EntityTagHandler = () => {}): void {
  builtInEntityTags.set(name, handler);
}

const entityTagDocs = tagDocRegistry(() => builtInEntityTags.keys());
/** Documents an entity tag for the reference pages. */
export const describeEntityTag = entityTagDocs.describe;
/** Every built-in entity tag with its documentation. */
export const documentedEntityTags = entityTagDocs.list;

export function isBuiltInEntityTag(name: string): boolean {
  return builtInEntityTags.has(name);
}

function entityTagError(context: EntityTagContext, tag: DocTag, reason: string): EntityParseError {
  return new EntityParseError(`${context.relativeFile}: invalid @${tag.name}: ${reason}`);
}

export function splitArgs(text: string): string[] {
  return text
    .split(",")
    .map((arg) => arg.trim())
    .filter((arg) => arg !== "");
}

export function parseHookTag(tag: DocTag, context: EntityTagContext): HookReference {
  let operations: CrudOperation[] = [...CRUD_OPERATIONS];
  let rest = tag.text;
  if (rest.startsWith(":")) {
    const [scope = "", ...argParts] = rest.slice(1).split(/\s+/);
    rest = argParts.join(" ");
    operations = splitArgs(scope).map((operation) => {
      if (!(CRUD_OPERATIONS as readonly string[]).includes(operation)) {
        throw entityTagError(context, tag, `unknown operation "${operation}" (use ${CRUD_OPERATIONS.join(", ")})`);
      }
      return operation as CrudOperation;
    });
  }
  return { name: tag.name, operations, args: splitArgs(rest) };
}

export function applyEntityTags(entity: EntityTagTarget, tags: DocTag[], context: EntityTagContext): void {
  for (const tag of tags) {
    const handler = builtInEntityTags.get(tag.name);
    if (handler) {
      handler(entity, tag, context);
      continue;
    }
    const parsed = applyFeatureTag(entity.tags, tag, "entity", context.relativeFile);
    if (parsed) {
      entity.tags = parsed;
      continue;
    }
    const hook = parseHookTag(tag, context);
    if (entity.hooks.some((existing) => existing.name === hook.name)) {
      throw entityTagError(context, tag, `hook "${hook.name}" is declared more than once`);
    }
    entity.hooks.push(hook);
  }
}

// The collection name itself is resolved together with the entity names.
registerEntityTag("collection");
// The schema is resolved together with the entity file location.
registerEntityTag("schema");
registerEntityTag("overrideHooks", (entity, tag, context) => {
  if (tag.text !== "inherit" && tag.text !== "replace") {
    throw entityTagError(context, tag, `expects inherit or replace, got "${tag.text}"`);
  }
  entity.overrideHooks = tag.text;
});
registerEntityTag("fields", (entity, tag, context) => {
  let operations: ("list" | "read")[] = ["list", "read"];
  let paths = tag.text;
  if (paths.startsWith(":")) {
    const [scope = "", ...rest] = paths.slice(1).split(/\s+/);
    paths = rest.join(" ");
    operations = splitArgs(scope).map((operation) => {
      if (operation !== "list" && operation !== "read") {
        throw entityTagError(context, tag, `unknown operation "${operation}" (use list or read)`);
      }
      return operation;
    });
  }
  const selections = (entity.fieldSelections ??= []);
  for (const operation of operations) {
    if (selections.some((selection) => selection.operations.includes(operation))) {
      throw entityTagError(context, tag, `@fields is declared more than once for ${operation}`);
    }
  }
  selections.push({ operations, paths });
});
registerEntityTag("populate", (entity, tag, context) => {
  let operations: ("list" | "read")[] = ["list", "read"];
  let paths = tag.text;
  if (paths.startsWith(":")) {
    const [scope = "", ...rest] = paths.slice(1).split(/\s+/);
    paths = rest.join(" ");
    operations = splitArgs(scope).map((operation) => {
      if (operation !== "list" && operation !== "read") {
        throw entityTagError(context, tag, `unknown operation "${operation}" (use list or read)`);
      }
      return operation;
    });
  }
  const list = splitArgs(paths);
  if (list.length === 0) throw entityTagError(context, tag, "needs at least one reference path");
  const populate = (entity.populate ??= {});
  for (const operation of operations) populate[operation] = [...new Set([...(populate[operation] ?? []), ...list])];
});
registerEntityTag("storage", (entity, tag, context) => {
  if (!/^[A-Za-z_$][\w$-]*$/.test(tag.text)) throw entityTagError(context, tag, "expects a storage name");
  entity.storageName = tag.text;
});
registerEntityTag("maxSize", (entity, tag, context) => {
  const size = parseSize(tag.text);
  if (size === undefined) throw entityTagError(context, tag, "expects a size like 512KB or 10MB");
  entity.fileLimits = { ...entity.fileLimits, maxSize: size };
});
registerEntityTag("accept", (entity, tag, context) => {
  const patterns = splitArgs(tag.text);
  if (patterns.length === 0 || !patterns.every((pattern) => /^[\w*.+-]+\/[\w*.+-]+$/.test(pattern))) {
    throw entityTagError(context, tag, "expects MIME patterns like image/png,image/*");
  }
  entity.fileLimits = { ...entity.fileLimits, accept: patterns };
});
registerEntityTag("access", (entity, tag, context) => {
  const [mode, ttl, ...rest] = splitArgs(tag.text.replace(/\s+/g, ","));
  if ((mode !== "direct" && mode !== "proxy" && mode !== "signed") || rest.length > 0) {
    throw entityTagError(context, tag, "expects direct, proxy or signed [ttlSeconds]");
  }
  if (ttl !== undefined && (mode !== "signed" || !/^[1-9]\d*$/.test(ttl))) {
    throw entityTagError(context, tag, "takes a ttl in seconds only in signed mode");
  }
  entity.fileAccess = { mode, ...(ttl !== undefined ? { ttl: Number(ttl) } : {}) };
});
registerEntityTag("internal", (entity, tag, context) => {
  if (tag.text !== "") throw entityTagError(context, tag, "takes no value");
  entity.internal = true;
});

describeEntityTag("collection", {
  description: "Name of the table or collection and of the routes (default: the plural of the entity name).",
  appliesTo: "Entities",
  example: "/** @collection people */\nexport type Person = { name: string }",
});
describeEntityTag("schema", {
  description: "Database schema of the entity (default: its folder inside `entities/`, or the default schema).",
  appliesTo: "Entities",
  example: "/** @schema auth */\nexport type Account = { email: string }",
});
describeEntityTag("overrideHooks", {
  description: "`inherit` (default) or `replace`: whether custom endpoints that override a generated route keep the entity's hooks.",
  appliesTo: "Entities",
  example: "/** @overrideHooks replace */\nexport type User = { email: string }",
});
describeEntityTag("fields", {
  description: "Fields the list and read routes return; scope it with `:list` or `:read`.",
  appliesTo: "Entities",
  example: "/** @fields:list id,name */\nexport type User = { name: string; bio?: string }",
});
describeEntityTag("populate", {
  description: "Reference paths populated by default on list and read; scope it with `:list` or `:read`.",
  appliesTo: "Entities",
  example: "/** @populate:read organization */\nexport type User = { organization: Organization }",
});
describeEntityTag("storage", {
  description: "Storage of a file entity's objects (default `default`).",
  appliesTo: "File entities",
  example: "/** @storage archive */\nexport type Document = File & { title?: string }",
});
describeEntityTag("maxSize", {
  description: "Largest upload a file entity accepts (default `files.maxSize`).",
  appliesTo: "File entities",
  example: "/** @maxSize 5MB */\nexport type Avatar = Media",
});
describeEntityTag("accept", {
  description: "MIME patterns a file entity accepts (default `files.accept`).",
  appliesTo: "File entities",
  example: "/** @accept image/png,image/jpeg */\nexport type Avatar = Media",
});
describeEntityTag("access", {
  description: "How file URLs work: `direct`, `proxy` or `signed [ttlSeconds]` (default `files.access`).",
  appliesTo: "File entities",
  example: "/** @access signed 60 */\nexport type Contract = File",
});
describeEntityTag("internal", {
  description: "Creates no routes for the entity; it is only used from code.",
  appliesTo: "Entities",
  example: "/** @internal */\nexport type AuditLog = { action: string }",
});
