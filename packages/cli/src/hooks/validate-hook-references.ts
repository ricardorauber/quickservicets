import type { EntityModel, HookCall } from "@quickservice/core";
import { BuildError } from "../errors.ts";
import type { HookEntry } from "./scan-hooks.ts";

export interface EndpointHooks {
  file: string;
  hooks: HookCall[];
}

/** Fails when an entity or endpoint references a hook that does not exist in `/hooks`. */
export function validateHookReferences(
  entities: EntityModel[],
  endpoints: EndpointHooks[],
  hooks: Map<string, HookEntry>,
): void {
  for (const entity of entities) {
    for (const hook of entity.hooks) {
      if (!hooks.has(hook.name)) {
        throw new BuildError(`entities/${entity.key}.ts: unknown hook @${hook.name} (no hooks/${hook.name}.ts)`);
      }
    }
  }
  for (const endpoint of endpoints) {
    for (const hook of endpoint.hooks) {
      if (!hooks.has(hook.name)) {
        throw new BuildError(`${endpoint.file}: unknown hook @${hook.name} (no hooks/${hook.name}.ts)`);
      }
    }
  }
}
