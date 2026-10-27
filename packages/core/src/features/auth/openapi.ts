import { addSecurityScheme, entityRoutePath, patternOf, type EntityModel, type OpenApiDoc, type ParsedTags, type SecurityScheme } from "../public.ts";
import { buildRouteRules, type RouteRule, type RuleOptions, type RuleSources } from "./routes.ts";

/** What the `x-auth` mark of an operation holds. */
export interface OperationAuth {
  roles?: string[];
  scopes?: string[];
}

/** The build warning when no provider documents how to authenticate. */
export const NO_AUTH_SCHEME_WARNING = "auth is enabled but no provider documents a security scheme in /openapi.json";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const ERROR_SCHEMA = { $ref: "#/components/schemas/Error" };

/** `/posts/{id}` → `/posts/[id]`, the route path form. */
const routePath = (path: string) => path.replace(/\{([^}]+)\}/g, "[$1]");

/** Every operation of a document with its method and path. */
function operations(doc: OpenApiDoc): { method: string; path: string; operation: Record<string, unknown> }[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => typeof item?.[method] === "object" && item[method] !== null).map((method) => ({ method, path, operation: item[method] as Record<string, unknown> })),
  );
}

/** What the marking reads besides the document: the tagged routes, the models, the options and the public paths. */
export interface MarkContext {
  routes: readonly { method: string; path: string; entity?: string; tags?: ParsedTags }[];
  models: readonly EntityModel[];
  options: RuleOptions;
  /** Paths of feature routes that answer anonymous callers, like the health probes. */
  publicPaths?: readonly string[];
}

/**
 * The entity and operation of a feature's `GET` route under an entity's collection, like a history route (`read`) or a
 * change stream (`list`), which the document has but the build's route index does not.
 */
function entityRouteOf(models: readonly EntityModel[], path: string): { entity: string; operation: "list" | "read" } | undefined {
  for (const model of models) {
    if (model.internal) continue;
    const collection = entityRoutePath(model);
    if (!path.startsWith(`${collection}/`)) continue;
    return { entity: model.key, operation: path.split("/").length - collection.split("/").length === 1 ? "list" : "read" };
  }
  return undefined;
}

/** The `x-auth` mark of a rule that needs a user. */
const markOf = (rule: RouteRule): OperationAuth => ({ ...(rule.roles ? { roles: [...rule.roles] } : {}), ...(rule.scopes.length > 0 ? { scopes: [...rule.scopes] } : {}) });

/**
 * Marks every operation that needs a user with `x-auth`, its 401 and 403 answers and role and scope notes, marks every
 * other operation public with `security: []`, and removes the default `bearerAuth` scheme and its requirements.
 */
export function markOperations(doc: OpenApiDoc, context: MarkContext): OpenApiDoc {
  const all = operations(doc);
  const known = new Set(context.routes.map((route) => `${route.method.toUpperCase()} ${patternOf(route.path)}`));
  // Feature routes the build does not index: GET routes under an entity's collection, and the public ones.
  const runtime = all
    .filter(({ method, path }) => !known.has(`${method.toUpperCase()} ${patternOf(routePath(path))}`))
    .flatMap(({ method, path }): RuleSources["runtime"][number][] => {
      const route = routePath(path);
      if ((context.publicPaths ?? []).includes(route)) return [{ method: method.toUpperCase(), path: route, auth: false }];
      const owner = method === "get" ? entityRouteOf(context.models, route) : undefined;
      return owner ? [{ method: "GET", path: route, ...owner }] : [];
    });
  const rules = buildRouteRules({ tagged: context.routes, runtime, models: context.models }, context.options);
  const byPattern = new Map([...rules].map(([key, rule]) => {
    const at = key.indexOf(" ");
    return [`${key.slice(0, at)} ${patternOf(key.slice(at + 1))}`, rule];
  }));
  const fallback = context.options.required === true;
  for (const { method, path, operation } of all) {
    const rule = byPattern.get(`${method.toUpperCase()} ${patternOf(routePath(path))}`);
    const needsUser = rule ? rule.user : fallback;
    if (Array.isArray(operation.security)) operation.security = (operation.security as Record<string, unknown>[]).filter((requirement) => !Object.hasOwn(requirement, "bearerAuth"));
    if (!needsUser) {
      operation.security = [];
      continue;
    }
    const mark = rule ? markOf(rule) : context.options.scopes.length > 0 ? { scopes: [...context.options.scopes] } : {};
    operation["x-auth"] = mark;
    if (Array.isArray(operation.security) && operation.security.length === 0) delete operation.security;
    const responses = (operation.responses ??= {}) as Record<string, unknown>;
    responses["401"] = { description: "Authentication required, or Invalid credentials", content: { "application/json": { schema: ERROR_SCHEMA } } };
    if (mark.roles || mark.scopes) responses["403"] = { description: "Not allowed, or Insufficient scope", content: { "application/json": { schema: ERROR_SCHEMA } } };
    const notes = [
      ...(mark.roles ? [`Requires one of the roles: ${mark.roles.join(", ")}.`] : []),
      ...(mark.scopes ? [`Requires the scopes: ${mark.scopes.join(", ")}.`] : []),
    ];
    if (notes.length > 0) operation.description = [operation.description, ...notes].filter((text) => typeof text === "string" && text !== "").join("\n\n");
  }
  const schemes = doc.components?.securitySchemes;
  if (schemes && Object.hasOwn(schemes, "bearerAuth")) {
    delete schemes.bearerAuth;
    if (Object.keys(schemes).length === 0) delete doc.components!.securitySchemes;
  }
  return doc;
}

/**
 * Adds a security scheme a provider accepts and requires it, as one alternative, on every operation marked `x-auth`:
 * with the operation's scopes (after `options.scopes`) for `oauth2` and `openIdConnect` schemes, and none for others.
 */
export function addAuthScheme(doc: OpenApiDoc, name: string, scheme: SecurityScheme, options: { scopes?: string[] } = {}): OpenApiDoc {
  addSecurityScheme(doc, name, scheme);
  const scoped = scheme.type === "oauth2" || scheme.type === "openIdConnect";
  for (const { operation } of operations(doc)) {
    const mark = operation["x-auth"] as OperationAuth | undefined;
    if (!mark) continue;
    const scopes = scoped ? [...new Set([...(options.scopes ?? []), ...(mark.scopes ?? [])])] : [];
    operation.security = [...((operation.security as Record<string, string[]>[] | undefined) ?? []), { [name]: scopes }];
  }
  return doc;
}

/** Whether a document offers any security scheme. */
export function hasSecurityScheme(doc: OpenApiDoc): boolean {
  return Object.keys(doc.components?.securitySchemes ?? {}).length > 0;
}
