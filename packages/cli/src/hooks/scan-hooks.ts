import { isHookDefinition, type HookDocs, type HookPhase } from "@quickservice/core";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isBuiltInEntityTag } from "../entities/entity-tags.ts";
import { isFieldTag } from "../entities/field-tags.ts";
import { BuildError } from "../errors.ts";
import { isBuiltInEndpointTag } from "./endpoint-tags.ts";

export interface HookEntry {
  name: string;
  phase: HookPhase;
  /** File path relative to the project root, or `@quickservice/core/features/...` for a native's file. */
  file: string;
  /** The key of the feature whose folder holds the file. */
  feature?: string;
  /** `options.docs` of the hook definition. */
  docs?: HookDocs;
}

const HOOK_NAME = /^[a-z][a-zA-Z0-9]*$/;

export function isReservedHookName(name: string): boolean {
  return isBuiltInEntityTag(name) || isFieldTag(name) || isBuiltInEndpointTag(name);
}

export async function scanHooks(projectRoot: string): Promise<Map<string, HookEntry>> {
  return scanHookFolder(join(projectRoot, "hooks"), (file) => relative(projectRoot, file));
}

/** Scans one hooks folder; `nameOf` gives the name the build shows for each file. */
export async function scanHookFolder(dir: string, nameOf: (file: string) => string): Promise<Map<string, HookEntry>> {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith(".ts")).sort();
  } catch {
    return new Map();
  }
  const hooks = new Map<string, HookEntry>();
  for (const entry of entries) {
    const file = nameOf(join(dir, entry));
    const name = entry.slice(0, -3);
    if (!HOOK_NAME.test(name)) {
      throw new BuildError(`${file}: hook file names must match ^[a-z][a-zA-Z0-9]*$`);
    }
    if (isReservedHookName(name)) {
      throw new BuildError(`${file}: "${name}" is a reserved tag name and cannot be used as a hook`);
    }
    const module = (await import(join(dir, entry))) as { default?: unknown };
    if (!isHookDefinition(module.default)) {
      throw new BuildError(`${file}: must default-export definePreHook(...) or definePostHook(...)`);
    }
    const { phase, docs } = module.default;
    hooks.set(name, { name, phase, file, ...(docs ? { docs } : {}) });
  }
  return hooks;
}
