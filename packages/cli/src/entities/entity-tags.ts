import { CRUD_OPERATIONS, type CrudOperation, type EntityModel, type HookReference } from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import type { DocTag } from "./jsdoc.ts";

export type EntityTagTarget = Pick<EntityModel, "hooks" | "overrideHooks" | "internal">;

export interface EntityTagContext {
  relativeFile: string;
}

type EntityTagHandler = (entity: EntityTagTarget, tag: DocTag, context: EntityTagContext) => void;

const builtInEntityTags = new Map<string, EntityTagHandler>();

/** Registers a built-in entity-level JSDoc tag. Every other entity tag is read as a hook reference. */
export function registerEntityTag(name: string, handler: EntityTagHandler = () => {}): void {
  builtInEntityTags.set(name, handler);
}

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
registerEntityTag("internal", (entity, tag, context) => {
  if (tag.text !== "") throw entityTagError(context, tag, "takes no value");
  entity.internal = true;
});
