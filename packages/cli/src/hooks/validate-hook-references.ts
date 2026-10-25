import type { EntityModel, HookCall } from "@quickservice/core";
import { BuildError } from "../errors.ts";
import { unknownTagMessage } from "../entities/feature-tags.ts";
import type { HookEntry } from "./scan-hooks.ts";

export interface EndpointHooks {
  file: string;
  hooks: HookCall[];
}

/** Fails when an entity or endpoint has a tag that is neither a hook of `/hooks` nor a tag of a feature or the core. */
export function validateHookReferences(
  entities: EntityModel[],
  endpoints: EndpointHooks[],
  hooks: Map<string, HookEntry>,
): void {
  for (const entity of entities) {
    for (const hook of entity.hooks) {
      if (!hooks.has(hook.name)) {
        throw new BuildError(unknownTagMessage(`entities/${entity.key}.ts`, hook.name));
      }
    }
  }
  for (const endpoint of endpoints) {
    for (const hook of endpoint.hooks) {
      if (!hooks.has(hook.name)) {
        throw new BuildError(unknownTagMessage(endpoint.file, hook.name));
      }
    }
  }
}
