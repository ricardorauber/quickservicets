import { patternOf } from "./http/router.ts";
import type { EntityModel, ParsedTags } from "./model.ts";

/** What `optionsFor` takes: an entity key or model, a field of an entity, or an endpoint by method and path. */
export type OptionsTarget = string | EntityModel | { entity: string; field: string } | { method: string; path: string };

interface Prepared {
  models: Map<string, EntityModel>;
  endpoints: Map<string, ParsedTags | undefined>;
}

let prepared: Prepared = { models: new Map(), endpoints: new Map() };

const endpointKey = (method: string, path: string) => `${method.toUpperCase()} ${patternOf(path)}`;

/**
 * Indexes the tags of the app's models and endpoints so `optionsFor` reads them without parsing; `createApp` calls it
 * with the generated models and endpoints.
 */
export function prepareFeatureTargets(models: readonly EntityModel[], endpoints: readonly { method: string; path: string; tags?: ParsedTags }[]): void {
  prepared = {
    models: new Map(models.map((model) => [model.key, model])),
    endpoints: new Map(endpoints.map((endpoint) => [endpointKey(endpoint.method, endpoint.path), endpoint.tags])),
  };
}

/** The feature tags written on a target, from the prepared models and endpoints. */
export function tagsOf(target: OptionsTarget): ParsedTags | undefined {
  if (typeof target === "string") return prepared.models.get(target)?.tags;
  if ("fields" in target && "entityName" in target) return target.tags;
  if ("field" in target) return prepared.models.get(target.entity)?.fields.find((field) => field.name === target.field)?.tags;
  if ("method" in target) return prepared.endpoints.get(endpointKey(target.method, target.path));
  return undefined;
}
