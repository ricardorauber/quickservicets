import type { ResolvedConfig } from "./config.ts";
import type { ResolvedFeature } from "./features.ts";
import type { EntityModel } from "./model.ts";

/** The generated OpenAPI 3.1 document, as feature and project functions receive it. */
export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version?: string; [key: string]: unknown };
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** What a feature's `openapi` function receives besides the document. */
export interface FeatureOpenApiContext<O = Record<string, unknown>> {
  models: readonly EntityModel[];
  options: O;
  config: ResolvedConfig;
}

/** What the project's `docs.openapi` function receives besides the document. */
export interface ProjectOpenApiContext {
  models: readonly EntityModel[];
  config: ResolvedConfig;
}

interface Described {
  description?: string;
}

/** `Authorization: Bearer <token>`, or HTTP basic credentials. */
export type HttpSecurityScheme = Described & ({ type: "http"; scheme: "bearer"; bearerFormat?: string } | { type: "http"; scheme: "basic" });

/** A key sent in a header, the query string or a cookie. */
export interface ApiKeySecurityScheme extends Described {
  type: "apiKey";
  in: "header" | "query" | "cookie";
  name: string;
}

/** The scopes of an OAuth2 flow, by name, with their descriptions. */
export type OAuthScopes = Record<string, string>;

/** OAuth2 with any of its four flows. */
export interface OAuth2SecurityScheme extends Described {
  type: "oauth2";
  flows: {
    authorizationCode?: { authorizationUrl: string; tokenUrl: string; refreshUrl?: string; scopes: OAuthScopes };
    clientCredentials?: { tokenUrl: string; refreshUrl?: string; scopes: OAuthScopes };
    password?: { tokenUrl: string; refreshUrl?: string; scopes: OAuthScopes };
    implicit?: { authorizationUrl: string; refreshUrl?: string; scopes: OAuthScopes };
  };
}

/** OpenID Connect discovery. */
export interface OpenIdConnectSecurityScheme extends Described {
  type: "openIdConnect";
  openIdConnectUrl: string;
}

/** A security scheme of the document's `components.securitySchemes`. */
export type SecurityScheme = HttpSecurityScheme | ApiKeySecurityScheme | OAuth2SecurityScheme | OpenIdConnectSecurityScheme;

const FLOW_FIELDS: Record<string, string[]> = {
  authorizationCode: ["authorizationUrl", "tokenUrl", "scopes"],
  clientCredentials: ["tokenUrl", "scopes"],
  password: ["tokenUrl", "scopes"],
  implicit: ["authorizationUrl", "scopes"],
};

/** The required fields a scheme lacks, by path, or a reason it is not a scheme. */
function schemeProblem(scheme: Record<string, unknown>): string | undefined {
  const missing = (object: Record<string, unknown>, fields: string[], prefix = "") => {
    const field = fields.find((name) => object[name] === undefined || object[name] === "");
    return field === undefined ? undefined : `${prefix}${field} is required`;
  };
  switch (scheme.type) {
    case "http":
      if (scheme.scheme !== "bearer" && scheme.scheme !== "basic") return 'scheme must be "bearer" or "basic"';
      return undefined;
    case "apiKey":
      if (!["header", "query", "cookie"].includes(scheme.in as string)) return missing(scheme, ["in"]) ?? 'in must be "header", "query" or "cookie"';
      return missing(scheme, ["name"]);
    case "oauth2": {
      const flows = scheme.flows as Record<string, Record<string, unknown> | undefined> | undefined;
      if (!flows || typeof flows !== "object") return "flows is required";
      const names = Object.keys(flows);
      if (names.length === 0) return "flows needs at least one flow";
      for (const name of names) {
        const fields = FLOW_FIELDS[name];
        if (!fields) return `flows.${name} is not an OAuth2 flow (use authorizationCode, clientCredentials, password or implicit)`;
        const problem = missing(flows[name] ?? {}, fields, `flows.${name}.`);
        if (problem) return problem;
      }
      return undefined;
    }
    case "openIdConnect":
      return missing(scheme, ["openIdConnectUrl"]);
    default:
      return 'type must be "http", "apiKey", "oauth2" or "openIdConnect"';
  }
}

/** Adds a security scheme to `components.securitySchemes`, throwing naming the field it lacks. */
export function addSecurityScheme(doc: OpenApiDoc, name: string, scheme: SecurityScheme): OpenApiDoc {
  const problem = schemeProblem(scheme as unknown as Record<string, unknown>);
  if (problem) throw new Error(`Security scheme ${name}: ${problem}`);
  doc.components ??= {};
  const schemes = (doc.components.securitySchemes ??= {});
  if (Object.hasOwn(schemes, name)) throw new Error(`Security scheme ${name} already exists`);
  schemes[name] = structuredClone(scheme);
  return doc;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Requires a defined scheme on every operation, or on those whose method (lowercase) and path `operations` accepts,
 * with the given scopes.
 */
export function requireSecurity(doc: OpenApiDoc, name: string, options: { scopes?: string[]; operations?: (method: string, path: string) => boolean } = {}): OpenApiDoc {
  if (!doc.components?.securitySchemes || !Object.hasOwn(doc.components.securitySchemes, name)) {
    throw new Error(`Security scheme ${name} is not defined; add it with addSecurityScheme first`);
  }
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = item[method] as { security?: Record<string, string[]>[] } | undefined;
      if (!operation || (options.operations && !options.operations(method, path))) continue;
      operation.security = [...(operation.security ?? []), { [name]: [...(options.scopes ?? [])] }];
    }
  }
  return doc;
}

/** Adds a component schema, throwing when one with the name exists. */
export function addSchema(doc: OpenApiDoc, name: string, schema: Record<string, unknown>): OpenApiDoc {
  doc.components ??= {};
  const schemas = (doc.components.schemas ??= {});
  if (Object.hasOwn(schemas, name)) throw new Error(`Schema ${name} already exists`);
  schemas[name] = schema;
  return doc;
}

/** Adds an operation at a method and path, throwing when the document already has one there. */
export function addOperation(doc: OpenApiDoc, method: string, path: string, operation: Record<string, unknown>): OpenApiDoc {
  const lower = method.toLowerCase();
  if (!METHODS.includes(lower)) throw new Error(`Invalid method ${method}`);
  const item = (doc.paths[path] ??= {});
  if (Object.hasOwn(item, lower)) throw new Error(`Operation ${method.toUpperCase()} ${path} already exists`);
  item[lower] = operation;
  return doc;
}

/** Why a value is not an OpenAPI 3.1 document, or undefined when it has the parts the server needs. */
function documentProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the result is not a document";
  const doc = value as Partial<OpenApiDoc>;
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.1")) return "openapi must be a 3.1 version";
  if (typeof doc.info?.title !== "string") return "info.title is required";
  if (typeof doc.paths !== "object" || doc.paths === null || Array.isArray(doc.paths)) return "paths must be an object";
  return undefined;
}

/** A function that changes a document in place or returns a new one. */
export type OpenApiFunction<C> = (doc: OpenApiDoc, context: C) => OpenApiDoc | void | undefined;

function applyOne<C>(doc: OpenApiDoc, fn: OpenApiFunction<C>, context: C, owner: string): OpenApiDoc {
  let result: unknown;
  try {
    result = fn(doc, context) ?? doc;
  } catch (error) {
    throw new Error(`${owner}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problem = documentProblem(result);
  if (problem) throw new Error(`${owner}: ${problem}`);
  return result as OpenApiDoc;
}

/**
 * Runs each enabled feature's `openapi` function in feature order, then the project's `docs.openapi`, each on the
 * document the previous one returned; fails with `<key>: openapi: <reason>` or `docs.openapi: <reason>`.
 */
export function extendOpenApi(doc: OpenApiDoc, { features, config, models }: { features: readonly ResolvedFeature[]; config: ResolvedConfig; models: readonly EntityModel[] }): OpenApiDoc {
  let current = doc;
  for (const feature of features) {
    const fn = feature.definition.openapi;
    if (fn) current = applyOne(current, fn as OpenApiFunction<FeatureOpenApiContext>, { models, options: feature.options, config }, `${feature.key}: openapi`);
  }
  const project = config.docs.openapi;
  if (project) current = applyOne(current, project, { models, config }, "docs.openapi");
  return current;
}
