import { DOCS_PATH, entityRoutePath, OPENAPI_PATH, operationForRoute, patternOf, type CrudOperation, type EntityModel, type ParsedTags } from "../public.ts";

/** The operations of the generated routes a `@roles` entry may name. */
export const ROLE_OPERATIONS: readonly CrudOperation[] = ["list", "read", "create", "update", "replace", "delete"];

/** The groups of operations a `@roles` entry may name. */
export const ROLE_GROUPS: Readonly<Record<string, readonly CrudOperation[]>> = { view: ["list", "read"], write: ["create", "update", "replace", "delete"] };

/** One `@roles` entry: a role, and the operations it restricts (every operation without one). */
export interface RoleEntry {
  role: string;
  operations?: readonly CrudOperation[];
}

/** Parses `<role>` or `<role>:<operation>`, or returns why it is invalid; operations are refused where `entity` is false. */
export function parseRoleEntry(entry: string, entity: boolean): RoleEntry | string {
  const at = entry.lastIndexOf(":");
  const role = at < 0 ? entry.trim() : entry.slice(0, at).trim();
  if (role === "") return `${JSON.stringify(entry)} has no role`;
  if (at < 0) return { role };
  const operation = entry.slice(at + 1).trim();
  if (!entity) return `${entry}: operations apply only to entities`;
  const group = ROLE_GROUPS[operation];
  if (group) return { role, operations: group };
  if (!(ROLE_OPERATIONS as readonly string[]).includes(operation)) {
    return `${entry}: unknown operation ${operation}; use ${[...ROLE_OPERATIONS, ...Object.keys(ROLE_GROUPS)].join(", ")}`;
  }
  return { role, operations: [operation as CrudOperation] };
}

/** What a route needs of its request, decided once per route. */
export interface RouteRule {
  /** True when the request must carry a signed-in user. */
  user: boolean;
  /** The roles of which the user must hold one, when the route is restricted by roles. */
  roles?: ReadonlySet<string>;
  /** The token scopes the request must carry. */
  scopes: readonly string[];
  /** The entity operation the route stands for, if any. */
  operation?: CrudOperation;
  /** The entity whose records the route serves, if any. */
  entity?: string;
  /** True when the route has an `@auth` tag (on or off), so the global `required` does not decide it. */
  tagged: boolean;
}

/** The options of the `auth` native the rules read. */
export interface RuleOptions {
  /** True, false, or undefined when a function decides per request. */
  required: boolean | undefined;
  scopes: readonly string[];
  roles: readonly string[];
}

/** A route with what the rules read of it. */
export interface RuleRoute {
  method: string;
  path: string;
  entity?: string;
  operation?: CrudOperation;
  tags?: ParsedTags;
  /** `false` for a runtime route registered as public. */
  auth?: boolean;
}

/** The rule of one route: its `@auth` and `@roles` tags (or the global options) for its operation. */
export function ruleOf(route: RuleRoute, options: RuleOptions): RouteRule {
  const authTag = route.tags?.auth;
  const rolesTag = route.tags?.roles;
  const base = { ...(route.operation ? { operation: route.operation } : {}), ...(route.entity ? { entity: route.entity } : {}) };
  if (route.auth === false) return { user: false, scopes: [], tagged: true, ...base };
  const entries = rolesTag ? (rolesTag.on ? ((rolesTag.options.roles as string[] | undefined) ?? []) : []) : options.roles;
  const applying = new Set<string>();
  for (const text of entries) {
    const entry = parseRoleEntry(text, route.entity !== undefined);
    if (typeof entry === "string") continue;
    if (!entry.operations || (route.operation !== undefined && entry.operations.includes(route.operation))) applying.add(entry.role);
  }
  const restricted = applying.size > 0;
  // @roles implies @auth for the routes it restricts, even over @auth off.
  const user = restricted || (authTag ? authTag.on : options.required === true);
  const scopes = user ? ((authTag?.on ? (authTag.options.scopes as string[] | undefined) : undefined) ?? options.scopes) : [];
  return { user, scopes, tagged: authTag !== undefined || restricted, ...(restricted ? { roles: applying } : {}), ...base };
}

/** What `buildRouteRules` reads: the app's routes with their tags, the runtime routes and the models. */
export interface RuleSources {
  tagged: readonly { method: string; path: string; entity?: string; tags?: ParsedTags }[];
  runtime: readonly { method: string; path: string; auth?: boolean; entity?: string; operation?: CrudOperation }[];
  models: readonly EntityModel[];
}

/**
 * The rule of every route that differs from the default, by `<METHOD> <path>`: routes needing a user, restricted by
 * roles or scopes, and, when every route needs a user, the public ones (runtime routes registered with `auth: false`
 * and the API docs). Endpoints and generated routes win over runtime routes with the same method and path.
 */
export function buildRouteRules(sources: RuleSources, options: RuleOptions): Map<string, RouteRule> {
  const models = new Map(sources.models.map((model) => [model.key, model]));
  const routes = new Map<string, RuleRoute>();
  const pattern = (route: { method: string; path: string }) => `${route.method.toUpperCase()} ${patternOf(route.path)}`;
  const add = (route: RuleRoute) => routes.set(pattern(route), route);
  for (const route of sources.runtime) {
    const model = route.entity !== undefined ? models.get(route.entity) : undefined;
    add({ ...route, ...(model?.tags ? { tags: model.tags } : {}) });
  }
  // The file route of a file entity serves its records' content: a read.
  for (const model of sources.models) {
    if (model.file && !model.internal) add({ method: "GET", path: `${entityRoutePath(model)}/[id]/file`, entity: model.key, operation: "read", ...(model.tags ? { tags: model.tags } : {}) });
  }
  for (const route of sources.tagged) {
    const model = route.entity !== undefined ? models.get(route.entity) : undefined;
    const operation = model ? operationForRoute(model, route.method, patternOf(route.path)) : undefined;
    add({ ...route, ...(operation ? { operation } : {}) });
  }
  const rules = new Map<string, RouteRule>();
  for (const route of routes.values()) {
    const rule = ruleOf(route, options);
    // With the default answer, nothing is stored: a request does no work for it.
    const sameScopes = rule.scopes.length === options.scopes.length && rule.scopes.every((scope, at) => scope === options.scopes[at]);
    const isDefault =
      options.required === true ? rule.user && !rule.roles && sameScopes : options.required === false ? !rule.user && !rule.roles : !rule.tagged && !rule.roles;
    if (!isDefault) rules.set(`${route.method.toUpperCase()} ${route.path}`, rule);
  }
  if (options.required !== false) {
    for (const path of [DOCS_PATH, OPENAPI_PATH]) rules.set(`GET ${path}`, { user: false, scopes: [], tagged: true });
  }
  return rules;
}
