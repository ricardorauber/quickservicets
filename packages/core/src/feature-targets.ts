import { patternOf } from "./http/router.ts";
import type { CrudOperation, EntityModel, ParsedTags } from "./model.ts";
import type { ServiceRequest } from "./hooks.ts";

/**
 * What `optionsFor` takes: an entity key or model, a field of an entity, an endpoint by method and path, or a request
 * (its endpoint's tags, or its entity's for a generated route).
 */
export type OptionsTarget = string | EntityModel | { entity: string; field: string } | { method: string; path: string } | ServiceRequest;

interface Prepared {
  models: Map<string, EntityModel>;
  endpoints: Map<string, ParsedTags | undefined>;
  /** Generated routes by method and pattern, with their entity key. */
  generated: Map<string, string>;
  /** Every route by method and path, in the order given: generated routes, then endpoints. */
  routes: Map<string, { method: string; path: string; entity?: string; tags?: ParsedTags }>;
}

let prepared: Prepared = { models: new Map(), endpoints: new Map(), generated: new Map(), routes: new Map() };

/** A route of the prepared app with the feature tags that apply to it. */
export interface TaggedRoute {
  method: string;
  /** The route path, with `[param]` segments. */
  path: string;
  /** The entity of a generated route, or of the generated route an endpoint replaces. */
  entity?: string;
  /** The endpoint's own tags over its entity's, by tag name; absent without tags. */
  tags?: ParsedTags;
}

const endpointKey = (method: string, path: string) => `${method.toUpperCase()} ${patternOf(path)}`;

/**
 * Indexes the tags of the app's models and endpoints so `optionsFor` reads them without parsing; `createApp` calls it
 * with the generated models and endpoints.
 */
export function prepareFeatureTargets(
  models: readonly EntityModel[],
  endpoints: readonly { method: string; path: string; tags?: ParsedTags }[],
  generated: readonly { method: string; path: string; entity: string }[] = [],
): void {
  const routes = new Map<string, { method: string; path: string; entity?: string; tags?: ParsedTags }>();
  for (const route of generated) routes.set(endpointKey(route.method, route.path), { method: route.method.toUpperCase(), path: route.path, entity: route.entity });
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint.method, endpoint.path);
    const entity = routes.get(key)?.entity;
    routes.set(key, { method: endpoint.method.toUpperCase(), path: endpoint.path, ...(entity !== undefined ? { entity } : {}), ...(endpoint.tags ? { tags: endpoint.tags } : {}) });
  }
  prepared = {
    models: new Map(models.map((model) => [model.key, model])),
    endpoints: new Map(endpoints.map((endpoint) => [endpointKey(endpoint.method, endpoint.path), endpoint.tags])),
    generated: new Map(generated.map((route) => [endpointKey(route.method, route.path), route.entity])),
    routes,
  };
}

/**
 * The routes of the prepared app, each with the feature tags that apply to it: a generated route has its entity's
 * tags, and an endpoint its own tags over those of the entity whose generated route it replaces, tag by tag.
 */
export function taggedRoutes(): TaggedRoute[] {
  return [...prepared.routes.values()].map((route) => {
    const entityTags = route.entity === undefined ? undefined : prepared.models.get(route.entity)?.tags;
    const tags = entityTags || route.tags ? { ...entityTags, ...route.tags } : undefined;
    return { method: route.method, path: route.path, ...(route.entity !== undefined ? { entity: route.entity } : {}), ...(tags && Object.keys(tags).length > 0 ? { tags } : {}) };
  });
}

/** The feature tags written on a target, from the prepared models and endpoints. */
export function tagsOf(target: OptionsTarget): ParsedTags | undefined {
  if (typeof target === "string") return prepared.models.get(target)?.tags;
  if ("fields" in target && "entityName" in target) return target.tags;
  if ("raw" in target && "route" in target) {
    const key = endpointKey(target.method, target.route);
    if (prepared.endpoints.has(key)) return prepared.endpoints.get(key);
    const entity = prepared.generated.get(key);
    return entity === undefined ? undefined : prepared.models.get(entity)?.tags;
  }
  if ("field" in target) return prepared.models.get(target.entity)?.fields.find((field) => field.name === target.field)?.tags;
  if ("method" in target) return prepared.endpoints.get(endpointKey(target.method, target.path));
  return undefined;
}

/** A route a feature registered at runtime, with what features that guard routes read of it. */
export interface RuntimeTarget {
  method: string;
  /** The route path, with `[param]` segments. */
  path: string;
  /** The key of the feature that registered it. */
  feature: string;
  /** `false` when the route stays public while the `auth` native requires a user everywhere. */
  auth?: boolean;
  /** The entity whose records the route serves. */
  entity?: string;
  /** The operation of the entity the route stands for. */
  operation?: CrudOperation;
}

let runtime: RuntimeTarget[] = [];

/** Forgets the runtime routes of a previous setup; the feature lifecycle calls it before the setups run. */
export function resetRuntimeTargets(): void {
  runtime = [];
}

/** Records a route a feature registered during its setup. */
export function registerRuntimeTarget(route: RuntimeTarget): void {
  runtime.push({
    method: route.method.toUpperCase(),
    path: route.path,
    feature: route.feature,
    ...(route.auth === false ? { auth: false } : {}),
    ...(route.entity !== undefined ? { entity: route.entity } : {}),
    ...(route.operation !== undefined ? { operation: route.operation } : {}),
  });
}

/** The routes features registered during the last setups, in registration order; final once the service starts. */
export function runtimeTargets(): readonly RuntimeTarget[] {
  return runtime;
}
