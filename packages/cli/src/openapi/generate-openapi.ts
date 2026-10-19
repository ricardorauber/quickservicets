import type { EndpointDoc } from "./endpoint-docs.ts";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  entityRoutePath,
  listQueryFields,
  resolveFileAccess,
  type FileAccessSettings,
  type CrudOperation,
  type CrudRouteEntry,
  type EntityModel,
  type HookCall,
  type HookDocs,
  type HookPhase,
  type NestedFieldModel,
  type Projection,
  type QueryItem,
  type QueryValueType,
  type TypeDescriptor,
} from "@quickservice/core";

export type JsonSchema = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes?: Record<string, JsonSchema> };
}

/** What the document needs from a hook: its phase and `options.docs`. */
export interface HookDocEntry {
  phase: HookPhase;
  docs?: HookDocs;
}

export interface GenerateOpenApiOptions {
  models: EntityModel[];
  /** Generated CRUD routes (method, path, entity key and operation). */
  routes: CrudRouteEntry[];
  /** Hooks by name (the hook registry), for phases and `options.docs`. */
  hooks?: ReadonlyMap<string, HookDocEntry>;
  packageJson: { name?: string; version?: string };
  /** Custom endpoints from `/endpoints`, see `describeEndpoints`. */
  endpoints?: EndpointDoc[];
  /** Storages and file settings, to document the file route of each file entity's access mode. */
  files?: Pick<FileAccessSettings, "storage" | "files">;
  /** Maximum segments of a populate path (default 2). */
  populateMaxDepth?: number;
}

type WriteMode = "create" | "replace" | "update";

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {
          type: "array",
          items: {
            type: "object",
            required: ["field", "message"],
            properties: { field: { type: "string" }, message: { type: "string" } },
          },
        },
      },
    },
  },
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  413: "Payload too large",
  415: "Unsupported media type",
};

const SYSTEM_PROPERTIES: Record<string, JsonSchema> = {
  id: { type: "string", format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
};

const pascalCase = (value: string) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

/** Component base names: the entity name, prefixed with its schema when another entity shares the name. */
export function componentNames(models: EntityModel[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.entityName, (counts.get(model.entityName) ?? 0) + 1);
  return new Map(
    models.map((model) => [
      model.key,
      model.schema && (counts.get(model.entityName) ?? 0) > 1 ? `${pascalCase(model.schema)}${model.entityName}` : model.entityName,
    ]),
  );
}

export function entityTag(model: EntityModel): string {
  return model.schema ? `${model.schema}/${model.name}` : model.name;
}

/** Component names of enum fields that use a shared schema for their named enum or alias. */
const sharedEnumNames = new WeakMap<TypeDescriptor, string>();

function enumDescriptorsOf(descriptor: TypeDescriptor): Extract<TypeDescriptor, { type: "enum" }>[] {
  if (descriptor.type === "enum") return descriptor.declaration ? [descriptor] : [];
  if (descriptor.type === "array") return enumDescriptorsOf(descriptor.items);
  if (descriptor.type === "object") return descriptor.fields.flatMap(enumDescriptorsOf);
  return [];
}

/**
 * Adds `components.schemas.<Name>` for each named enum or alias and points its fields at it; a name that is also an
 * entity schema, a generated schema or another declaration's name keeps its fields inline.
 */
function registerSharedEnums(entities: EntityModel[], names: Map<string, string>, schemas: Record<string, JsonSchema>): void {
  const taken = new Set(["Error"]);
  for (const name of names.values()) for (const suffix of ["", "Create", "Replace", "Update", "ListItem", "Read"]) taken.add(`${name}${suffix}`);
  const descriptors = entities.flatMap((model) => model.fields.flatMap(enumDescriptorsOf));
  const filesByName = new Map<string, Set<string>>();
  for (const { declaration } of descriptors) {
    (filesByName.get(declaration!.name) ?? filesByName.set(declaration!.name, new Set()).get(declaration!.name)!).add(declaration!.file);
  }
  for (const descriptor of descriptors) {
    const { name } = descriptor.declaration!;
    if (taken.has(name) || filesByName.get(name)!.size > 1) {
      sharedEnumNames.delete(descriptor);
      continue;
    }
    schemas[name] = { type: "string", enum: [...descriptor.values] };
    sharedEnumNames.set(descriptor, name);
  }
}

function withNull(schema: JsonSchema): JsonSchema {
  if (typeof schema.$ref === "string") return { oneOf: [schema, { type: "null" }] };
  const type = schema.type as string;
  const result: JsonSchema = { ...schema, type: [type, "null"] };
  if (Array.isArray(schema.enum)) result.enum = [...(schema.enum as unknown[]), null];
  return result;
}

function descriptorSchema(descriptor: TypeDescriptor, visible: (field: NestedFieldModel) => boolean, mode: WriteMode | "response"): JsonSchema {
  switch (descriptor.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "enum": {
      const shared = sharedEnumNames.get(descriptor);
      return shared ? ref(shared) : { type: "string", enum: [...descriptor.values] };
    }
    case "ref":
      return { type: "string", format: "uuid" };
    case "refArray":
      return { type: "array", items: { type: "string", format: "uuid" } };
    case "array":
      return { type: "array", items: descriptorSchema(descriptor.items, visible, mode) };
    case "object":
      return objectSchema(descriptor.fields, visible, mode);
    case "json":
      return {};
  }
}

function fieldSchema(field: NestedFieldModel, visible: (field: NestedFieldModel) => boolean, mode: WriteMode | "response"): JsonSchema {
  const schema = descriptorSchema(field, visible, mode);
  if (field.type === "number" && field.integer) schema.type = "integer";
  const isArray = field.type === "array" || field.type === "refArray";
  if (field.minLength !== undefined) schema[isArray ? "minItems" : "minLength"] = field.minLength;
  if (field.maxLength !== undefined) schema[isArray ? "maxItems" : "maxLength"] = field.maxLength;
  if (field.min !== undefined) schema.minimum = field.min;
  if (field.max !== undefined) schema.maximum = field.max;
  if (field.format) schema.format = field.format === "url" ? "uri" : field.format;
  if (field.default !== undefined) schema.default = field.default;
  if (field.type === "refArray" && mode !== "response") return referenceArrayBody(schema, field.optional, mode);
  return field.optional ? withNull(schema) : schema;
}

const ID_LIST: JsonSchema = { type: "array", items: { type: "string", format: "uuid" }, uniqueItems: true };

/** A reference array in a body: unique ids, or on PATCH also `{ add, remove }`. */
function referenceArrayBody(schema: JsonSchema, optional: boolean, mode: WriteMode): JsonSchema {
  const list: JsonSchema = { ...schema, uniqueItems: true };
  if (mode !== "update") return optional ? withNull(list) : list;
  const change: JsonSchema = {
    type: "object",
    properties: { add: ID_LIST, remove: ID_LIST },
    additionalProperties: false,
  };
  return { oneOf: [list, change, ...(optional ? [{ type: "null" }] : [])] };
}

function isRequired(field: NestedFieldModel, mode: WriteMode | "response"): boolean {
  if (field.optional || mode === "update") return false;
  // Bodies may leave reference arrays out; they are stored as empty lists.
  if (field.type === "refArray" && mode !== "response") return false;
  return mode !== "create" || field.default === undefined;
}

function objectSchema(fields: NestedFieldModel[], visible: (field: NestedFieldModel) => boolean, mode: WriteMode | "response"): JsonSchema {
  const shown = fields.filter(visible);
  // Nested objects are sent whole, so their own required fields apply even in updates.
  const nestedMode = mode === "update" ? "replace" : mode;
  const properties = Object.fromEntries(shown.map((field) => [field.name, fieldSchema(field, visible, nestedMode)]));
  const required = shown.filter((field) => isRequired(field, nestedMode)).map((field) => field.name);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(mode === "response" ? {} : { additionalProperties: false }),
  };
}

/** A reference that population may replace: the id, or the target's read schema. */
function populatableSchema(field: NestedFieldModel & { type: "ref" | "refArray" }, target: string): JsonSchema {
  const one = { oneOf: [{ type: "string", format: "uuid" }, ref(target)] };
  if (field.type === "ref") return field.optional ? { oneOf: [...one.oneOf, { type: "null" }] } : one;
  const schema: JsonSchema = { type: field.optional ? ["array", "null"] : "array", items: one };
  if (field.minLength !== undefined) schema.minItems = field.minLength;
  if (field.maxLength !== undefined) schema.maxItems = field.maxLength;
  return schema;
}

/**
 * The response schema: system fields and every field that is not `@hidden`. With `readSchemaOf`, references are
 * `oneOf` the id and the referenced entity's read schema.
 */
export function responseSchema(model: EntityModel, readSchemaOf?: (target: string) => string | undefined): JsonSchema {
  const visible = (field: NestedFieldModel) => !field.hidden;
  const shown = model.fields.filter(visible);
  const propertyOf = (field: (typeof shown)[number]) => {
    const target = (field.type === "ref" || field.type === "refArray") && readSchemaOf?.(field.target);
    return target ? populatableSchema(field as NestedFieldModel & { type: "ref" | "refArray" }, target) : fieldSchema(field, visible, "response");
  };
  return {
    type: "object",
    properties: {
      ...SYSTEM_PROPERTIES,
      ...Object.fromEntries(shown.map((field) => [field.name, propertyOf(field)])),
    },
    required: ["id", "createdAt", "updatedAt", ...shown.filter((field) => !field.optional).map((field) => field.name)],
  };
}

/** A write schema: the fields a JSON body may set, with the fields required by the operation. */
export function writeSchema(model: EntityModel, mode: WriteMode): JsonSchema {
  const writable = (field: NestedFieldModel) => !field.readOnly || (mode === "update" && field.readOnly === "unlessPatch");
  const shown = model.fields.filter(writable);
  const required = shown.filter((field) => isRequired(field, mode)).map((field) => field.name);
  return {
    type: "object",
    properties: Object.fromEntries(shown.map((field) => [field.name, fieldSchema(field, writable, mode)])),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}
const json = (schema: JsonSchema) => ({ "application/json": { schema } });
const multipart = (schema: JsonSchema) => ({ "multipart/form-data": { schema } });
const BINARY: JsonSchema = { type: "string", format: "binary" };

/** `1048576` → `1 MB`. */
function formatSize(bytes: number): string {
  for (const [unit, size] of [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  }
  return `${bytes} bytes`;
}

/** The file entity a reference field targets, when the field can take uploads. */
function fileTargetOf(field: EntityModel["fields"][number], models: EntityModel[]): EntityModel | undefined {
  if ((field.type !== "ref" && field.type !== "refArray") || field.storage === "derived") return undefined;
  const target = models.find((model) => model.key === field.target);
  return target?.file ? target : undefined;
}

/** The multipart variant of a write schema: file reference fields become binary parts, with their limits described. */
function multipartSchema(model: EntityModel, json: JsonSchema, models: EntityModel[]): JsonSchema {
  const properties = { ...(json.properties as Record<string, JsonSchema>) };
  for (const field of model.fields) {
    if (!(field.name in properties) || !fileTargetOf(field, models)) continue;
    const limits = [
      field.fileLimits?.maxSize !== undefined ? `Max size: ${formatSize(field.fileLimits.maxSize)}.` : "",
      field.fileLimits?.maxTotalSize !== undefined ? `Max total size: ${formatSize(field.fileLimits.maxTotalSize)}.` : "",
      field.fileLimits?.accept ? `Accepted types: ${field.fileLimits.accept.join(", ")}.` : "",
      field.type === "refArray" && field.minLength !== undefined ? `Min items: ${field.minLength}.` : "",
      field.type === "refArray" && field.maxLength !== undefined ? `Max items: ${field.maxLength}.` : "",
    ].filter((text) => text !== "");
    const description = ["File upload.", ...limits].join(" ");
    properties[field.name] = field.type === "refArray" ? { type: "array", items: BINARY, description } : { ...BINARY, description };
  }
  return { ...json, properties };
}

/** The multipart body of a file entity: the required `file` part and the entity's own writable fields. */
function fileUploadSchema(json: JsonSchema): JsonSchema {
  const { additionalProperties: _, ...rest } = json;
  return {
    ...rest,
    properties: { file: BINARY, ...(json.properties as Record<string, JsonSchema>) },
    required: ["file", ...((json.required as string[] | undefined) ?? [])],
  };
}

function errorResponses(codes: number[]): Record<string, unknown> {
  return Object.fromEntries(
    codes.map((code) => [String(code), { description: ERROR_DESCRIPTIONS[code] ?? "Error", content: json(ref("Error")) }]),
  );
}

/** Whether a record of the entity can be referenced by a record of another entity. */
function isReferencedByOthers(model: EntityModel, models: EntityModel[]): boolean {
  return models.some(
    (other) =>
      other.key !== model.key &&
      !other.link &&
      other.fields.some((field) => (field.type === "ref" || field.type === "refArray") && field.target === model.key && field.storage !== "derived"),
  );
}

function listParameters(model: EntityModel): unknown[] {
  const fields = listQueryFields(model);
  const sortable = fields.filter((field) => field.sortable).map((field) => field.name);
  const filters = fields.map((field) => `- \`${field.name}\`: ${field.operators.join(", ")}`).join("\n");
  return [
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT } },
    { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
    {
      name: "sort",
      in: "query",
      description: `Comma-separated fields; prefix a field with \`-\` to sort descending. Default: \`-createdAt\`. Sortable fields: ${sortable.map((name) => `\`${name}\``).join(", ")}.`,
      schema: { type: "string", default: "-createdAt" },
    },
    {
      name: "where",
      in: "query",
      style: "deepObject",
      explode: true,
      description: `Filters as \`where[<field>][<op>]=<value>\`. Filterable fields and operators:\n${filters}`,
      schema: { type: "object", additionalProperties: true },
    },
  ];
}

const ID_PARAMETER = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

type PathTree = Map<string, PathTree | true>;

function pathTree(paths: readonly string[]): PathTree {
  const root: PathTree = new Map();
  for (const path of paths) {
    let node = root;
    const segments = path.split(".");
    segments.forEach((segment, index) => {
      const existing = node.get(segment);
      if (existing === true) return;
      if (index === segments.length - 1) return void node.set(segment, true);
      const child: PathTree = existing ?? new Map();
      node.set(segment, child);
      node = child;
    });
  }
  return root;
}

/** The schema a `$ref` points to, or the schema itself. */
function dereference(schema: JsonSchema, schemas: Record<string, JsonSchema>): JsonSchema {
  const target = typeof schema.$ref === "string" ? schemas[schema.$ref.replace("#/components/schemas/", "")] : undefined;
  return target ? structuredClone(target) : schema;
}

/** Applies `select` to the properties of an object schema, looking through `$ref`s and arrays. */
function mapProperties(
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  select: (properties: Record<string, JsonSchema>) => Record<string, JsonSchema>,
): JsonSchema {
  const resolved = dereference(schema, schemas);
  if (resolved.items) return { ...resolved, items: mapProperties(resolved.items as JsonSchema, schemas, select) };
  if (!resolved.properties) return resolved;
  const properties = select(resolved.properties as Record<string, JsonSchema>);
  const required = (resolved.required as string[] | undefined)?.filter((name) => name in properties);
  const { required: _, ...rest } = resolved;
  return { ...rest, properties, ...(required && required.length > 0 ? { required } : {}) };
}

function keepPaths(schema: JsonSchema, tree: PathTree, schemas: Record<string, JsonSchema>): JsonSchema {
  return mapProperties(schema, schemas, (properties) => {
    const kept: Record<string, JsonSchema> = {};
    for (const [name, subtree] of tree) {
      if (!(name in properties)) continue;
      kept[name] = subtree === true ? properties[name]! : keepPaths(properties[name]!, subtree, schemas);
    }
    return kept;
  });
}

function dropPaths(schema: JsonSchema, tree: PathTree, schemas: Record<string, JsonSchema>): JsonSchema {
  return mapProperties(schema, schemas, (properties) => {
    const kept: Record<string, JsonSchema> = { ...properties };
    for (const [name, subtree] of tree) {
      if (!(name in kept)) continue;
      if (subtree === true) delete kept[name];
      else kept[name] = dropPaths(kept[name]!, subtree, schemas);
    }
    return kept;
  });
}

/** Removes every `required` list, since client field selection can leave out any property. */
function allOptional(schema: JsonSchema): JsonSchema {
  const { required: _, ...rest } = schema;
  const result: JsonSchema = { ...rest };
  if (rest.items) result.items = allOptional(rest.items as JsonSchema);
  if (rest.properties) {
    result.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, JsonSchema>).map(([name, property]) => [name, allOptional(property)]),
    );
  }
  return result;
}

/** The schema with only the paths a projection exposes, or undefined when it exposes everything. */
export function projectSchema(schema: JsonSchema, projection: Projection, schemas: Record<string, JsonSchema> = {}): JsonSchema | undefined {
  const full = dereference(schema, schemas);
  let projected = projection.include && projection.include.length > 0 ? keepPaths(full, pathTree(projection.include), schemas) : full;
  if (projection.exclude && projection.exclude.length > 0) projected = dropPaths(projected, pathTree(projection.exclude), schemas);
  return JSON.stringify(projected) === JSON.stringify(full) ? undefined : allOptional(projected);
}

/** Every property path of a schema, including nested ones (`address`, `address.city`). */
export function schemaPaths(schema: JsonSchema, prefix = ""): string[] {
  const target = schema.items ? (schema.items as JsonSchema) : schema;
  const properties = (target.properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(properties).flatMap(([name, property]) => [`${prefix}${name}`, ...schemaPaths(property, `${prefix}${name}.`)]);
}

function selectionParameters(schema: JsonSchema): unknown[] {
  const paths = schemaPaths(schema).map((path) => `\`${path}\``).join(", ");
  return [
    {
      name: "fields",
      in: "query",
      required: false,
      description: `Comma-separated paths to return. Selectable paths: ${paths}.`,
      schema: { type: "string" },
    },
    {
      name: "exclude",
      in: "query",
      required: false,
      description: `Comma-separated paths to leave out. Selectable paths: ${paths}.`,
      schema: { type: "string" },
    },
  ];
}

/** Component names of the list item and read schemas: projected ones when the operation exposes fewer paths. */
interface ReadSchemas {
  list: string;
  read: string;
  schemas: Record<string, JsonSchema>;
  /** Paths the `populate` parameter accepts. */
  populate: string[];
}

/** Reference paths an entity can populate, up to `maxDepth` segments; hidden references are left out. */
export function populatePathsOf(model: EntityModel, models: EntityModel[], maxDepth: number, prefix = ""): string[] {
  if (maxDepth <= 0) return [];
  return model.fields.flatMap((field) => {
    if ((field.type !== "ref" && field.type !== "refArray") || field.hidden) return [];
    const path = `${prefix}${field.name}`;
    const target = models.find((candidate) => candidate.key === field.target);
    return [path, ...(target ? populatePathsOf(target, models, maxDepth - 1, `${path}.`) : [])];
  });
}

function populateParameters(paths: string[]): unknown[] {
  if (paths.length === 0) return [];
  return [
    {
      name: "populate",
      in: "query",
      required: false,
      description: `Comma-separated reference paths to replace with the referenced records. Allowed paths: ${paths.map((path) => `\`${path}\``).join(", ")}.`,
      schema: { type: "string" },
    },
  ];
}

function operationFor(
  model: EntityModel,
  operation: CrudOperation,
  name: string,
  models: EntityModel[],
  readSchemas: ReadSchemas,
): Record<string, unknown> {
  const unique = model.fields.some((field) => field.unique);
  const conflict = unique ? [409] : [];
  const record = { content: json(ref(name)) };
  const hasFileReferences = model.fields.some((field) => fileTargetOf(field, models) !== undefined);
  const body = (schema: string) => {
    if (model.file && !schema.endsWith("Update")) {
      return { required: true, content: multipart(fileUploadSchema(readSchemas.schemas[schema]!)) };
    }
    if (!hasFileReferences) return { required: true, content: json(ref(schema)) };
    return { required: true, content: { ...json(ref(schema)), ...multipart(multipartSchema(model, readSchemas.schemas[schema]!, models)) } };
  };
  const uploadErrors = model.file ? [413, 415] : [];
  const base = { tags: [entityTag(model)], operationId: `${operation}${name}` };
  switch (operation) {
    case "list":
      return {
        ...base,
        parameters: [
          ...listParameters(model),
          ...selectionParameters(readSchemas.schemas[readSchemas.list]!),
          ...populateParameters(readSchemas.populate),
        ],
        responses: {
          "200": {
            description: `A page of ${model.name}`,
            content: json({
              type: "object",
              required: ["data", "total", "limit", "offset"],
              properties: {
                data: { type: "array", items: ref(readSchemas.list) },
                total: { type: "integer" },
                limit: { type: "integer" },
                offset: { type: "integer" },
              },
            }),
          },
          ...errorResponses([400]),
        },
      };
    case "read":
      return {
        ...base,
        parameters: [ID_PARAMETER, ...selectionParameters(readSchemas.schemas[readSchemas.read]!), ...populateParameters(readSchemas.populate)],
        responses: { "200": { description: `The ${model.entityName}`, content: json(ref(readSchemas.read)) }, ...errorResponses([404]) },
      };
    case "create":
      return {
        ...base,
        requestBody: body(`${name}Create`),
        responses: { "201": { description: `The created ${model.entityName}`, ...record }, ...errorResponses([400, ...conflict, ...uploadErrors]) },
      };
    case "update":
      return {
        ...base,
        parameters: [ID_PARAMETER],
        requestBody: body(`${name}Update`),
        responses: { "200": { description: `The updated ${model.entityName}`, ...record }, ...errorResponses([400, 404, ...conflict]) },
      };
    case "replace":
      return {
        ...base,
        parameters: [ID_PARAMETER],
        requestBody: body(`${name}Replace`),
        responses: {
          "200": { description: `The replaced ${model.entityName}`, ...record },
          ...errorResponses([400, 404, ...conflict, ...uploadErrors]),
        },
      };
    case "delete":
      return {
        ...base,
        parameters: [ID_PARAMETER],
        responses: {
          "204": { description: `The ${model.entityName} was deleted` },
          ...errorResponses(isReferencedByOthers(model, models) ? [404, 409] : [404]),
        },
      };
  }
}

/** `/users/[id]` → `/users/{id}`. */
export function openApiPath(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, "{$1}");
}

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];
const BODY_METHODS = new Set(["post", "put", "patch"]);

/** `/organizations/[orgId]/stats` → `OrganizationsOrgIdStats`; `/` → `Root`. */
function pascalPath(path: string): string {
  return pascalCase(path.replace(/[[\]]/g, "")) || "Root";
}

function pathParameters(params: string[]): unknown[] {
  return params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
}

/** Tag (first static segment, or `root`) and operation id (method plus PascalCase path) of a custom endpoint. */
function endpointIdentity(doc: EndpointDoc): { tags: string[]; operationId: string } {
  const tag = doc.path.split("/").find((segment) => segment !== "" && !segment.startsWith("[")) ?? "root";
  return { tags: [tag], operationId: `${doc.method.toLowerCase()}${pascalPath(doc.path)}` };
}

/** The schema of one query value; a named enum or alias uses its shared schema when the name is free or matches. */
function queryValueSchema(type: QueryValueType, schemas: Record<string, JsonSchema>): JsonSchema {
  switch (type.type) {
    case "date":
      return { type: "string", format: "date-time" };
    case "enum": {
      const inline = { type: "string", enum: [...type.values] };
      if (!type.enumName) return inline;
      schemas[type.enumName] ??= inline;
      return JSON.stringify(schemas[type.enumName]) === JSON.stringify(inline) ? ref(type.enumName) : inline;
    }
    default:
      return { type: type.type };
  }
}

/** Query parameters of typed query items, with their tags. */
function queryParameters(items: QueryItem[], schemas: Record<string, JsonSchema>): unknown[] {
  return items.map((item) => {
    const valueType = item.type === "array" ? item.items : (item as QueryValueType);
    const valueSchema = valueType.type === "number" && item.limits?.integer ? { type: "integer" } : queryValueSchema(valueType, schemas);
    const limits = {
      ...(item.limits?.min !== undefined ? { minimum: item.limits.min } : {}),
      ...(item.limits?.max !== undefined ? { maximum: item.limits.max } : {}),
      ...(item.limits?.minLength !== undefined ? { minLength: item.limits.minLength } : {}),
      ...(item.limits?.maxLength !== undefined ? { maxLength: item.limits.maxLength } : {}),
    };
    const withLimits = Object.keys(limits).length > 0 ? (valueSchema.$ref ? { allOf: [valueSchema], ...limits } : { ...valueSchema, ...limits }) : valueSchema;
    const schema = item.type === "array" ? { type: "array", items: withLimits } : withLimits;
    if (item.default !== undefined) (schema as JsonSchema).default = item.default;
    return {
      name: item.name,
      in: "query",
      required: !item.optional && item.default === undefined,
      ...(item.type === "array" ? { style: "form", explode: true } : {}),
      schema,
    };
  });
}

function customOperation(doc: EndpointDoc, schemas: Record<string, JsonSchema>): Record<string, unknown> {
  const method = doc.method.toLowerCase();
  const status = doc.status ?? (method === "delete" && !doc.result ? 204 : 200);
  const success =
    status === 204
      ? { "204": { description: "Success" } }
      : { [String(status)]: { description: "Success", content: json(doc.result ?? { type: "object" }) } };
  return {
    ...endpointIdentity(doc),
    ...(doc.params.length > 0 || doc.query ? { parameters: [...pathParameters(doc.params), ...queryParameters(doc.query ?? [], schemas)] } : {}),
    ...(BODY_METHODS.has(method) ? { requestBody: { required: true, content: json(doc.body ?? { type: "object" }) } } : {}),
    responses: success,
  };
}

/** The generated operation's schemas, parameters and responses, with the endpoint's path, types and texts taking precedence. */
function overriddenOperation(doc: EndpointDoc, generated: Record<string, unknown>, schemas: Record<string, JsonSchema>): Record<string, unknown> {
  const operation: Record<string, any> = { ...structuredClone(generated), ...endpointIdentity(doc) };
  // The generated query parameters are never inherited: the override documents its path and typed query items only.
  const parameters = [...pathParameters(doc.params), ...queryParameters(doc.query ?? [], schemas)];
  if (parameters.length > 0) operation.parameters = parameters;
  else delete operation.parameters;
  if (doc.body && operation.requestBody) operation.requestBody = { required: true, content: json(doc.body) };
  if (doc.result) {
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    const code = Object.keys(responses).find((status) => status.startsWith("2"))!;
    const status = code === "204" ? "200" : code;
    delete responses[code];
    operation.responses = { [status]: { description: "Success", content: json(doc.result) }, ...responses };
  }
  if (doc.status !== undefined) {
    // `@status` moves the success response to its code; 204 has no content.
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    const code = Object.keys(responses).find((status) => status.startsWith("2"))!;
    const { content, ...rest } = responses[code]!;
    delete responses[code];
    const success = doc.status === 204 ? rest : { ...rest, content: content ?? json(doc.result ?? { type: "object" }) };
    operation.responses = { [String(doc.status)]: success, ...responses };
  }
  return operation;
}

function sortKeys<T>(record: Record<string, T>, compare?: (a: string, b: string) => number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (compare ? compare(a, b) : a < b ? -1 : a > b ? 1 : 0)));
}

/** Projects the success response schema of an endpoint with `@fields`/`@exclude`; unknown schemas stay as they are. */
function projectSuccessResponse(
  operation: Record<string, any>,
  projection: Projection,
  schemas: Record<string, JsonSchema>,
  isList: boolean,
): void {
  const responses = operation.responses as Record<string, any>;
  const code = Object.keys(responses).find((status) => status.startsWith("2"));
  const content = code ? responses[code].content?.["application/json"] : undefined;
  if (!content) return;
  const schema = content.schema as JsonSchema;
  // A list response projects its items, not the page envelope.
  const data = (schema.properties as Record<string, JsonSchema> | undefined)?.data;
  if (isList && data?.items) {
    const items = projectSchema(data.items as JsonSchema, projection, schemas);
    if (items) content.schema = { ...schema, properties: { ...(schema.properties as object), data: { ...data, items } } };
    return;
  }
  content.schema = projectSchema(schema, projection, schemas) ?? schema;
}

/** Adds the hook line, `x-hooks`, hook error responses and security to an operation; returns whether bearer auth is used. */
function documentHooks(operation: Record<string, any>, declared: HookCall[], hooks: ReadonlyMap<string, HookDocEntry>): boolean {
  // The runtime runs every pre-hook before the handler and every post-hook after it, each group in declared order.
  const calls = [
    ...declared.filter((call) => hooks.get(call.name)?.phase !== "post"),
    ...declared.filter((call) => hooks.get(call.name)?.phase === "post"),
  ];
  const line = `Hooks: ${calls.map((call) => (call.args.length > 0 ? `${call.name}(${call.args.join(", ")})` : call.name)).join(", ")}`;
  operation.description = operation.description ? `${operation.description}\n\n${line}` : line;
  operation["x-hooks"] = calls.map((call) => ({ name: call.name, phase: hooks.get(call.name)?.phase, args: call.args }));
  let bearer = false;
  for (const call of calls) {
    const docs = hooks.get(call.name)?.docs;
    for (const code of docs?.responses ?? []) {
      operation.responses[String(code)] ??= errorResponses([code])[String(code)];
    }
    if (docs?.security === "bearer") bearer = true;
  }
  if (bearer) operation.security = [{ bearerAuth: [] }];
  return bearer;
}

/** The file route of a file entity in proxy or signed mode. */
function fileOperation(model: EntityModel, name: string, signed: boolean): Record<string, unknown> {
  const signature = [
    { name: "expires", in: "query", required: true, description: "Expiry of the signed URL, in unix seconds.", schema: { type: "integer" } },
    { name: "signature", in: "query", required: true, description: "Signature of the URL.", schema: { type: "string" } },
  ];
  return {
    tags: [entityTag(model)],
    operationId: `download${name}`,
    parameters: [ID_PARAMETER, ...(signed ? signature : [])],
    responses: {
      "200": { description: `The ${model.entityName} content`, content: { "*/*": { schema: BINARY } } },
      ...errorResponses(signed ? [403, 404] : [404]),
    },
  };
}

/** Builds the OpenAPI 3.1 document of the entities and their generated CRUD routes. */
export function generateOpenApi({
  models,
  routes,
  packageJson,
  endpoints = [],
  hooks = new Map(),
  files,
  populateMaxDepth = 2,
}: GenerateOpenApiOptions): OpenApiDocument {
  // System entities (e.g. JobRun) have no routes and stay out of the API docs.
  const entities = models.filter((model) => !model.link && !model.system);
  const names = componentNames(entities);
  const schemas: Record<string, JsonSchema> = { Error: ERROR_SCHEMA };
  registerSharedEnums(entities, names, schemas);
  // Which entities need projected read schemas does not depend on how references are shown, so it is decided first.
  const readNames = new Map<string, string>();
  for (const model of entities) {
    const name = names.get(model.key)!;
    readNames.set(model.key, projectSchema(responseSchema(model), model.exposure.read) ? `${name}Read` : name);
  }
  for (const model of entities) {
    const name = names.get(model.key)!;
    schemas[name] = responseSchema(model, (target) => readNames.get(target));
    schemas[`${name}Create`] = writeSchema(model, "create");
    schemas[`${name}Replace`] = writeSchema(model, "replace");
    schemas[`${name}Update`] = writeSchema(model, "update");
  }
  const readSchemas = new Map<string, ReadSchemas>();
  for (const model of entities) {
    const name = names.get(model.key)!;
    const listItem = projectSchema(schemas[name]!, model.exposure.list);
    const read = projectSchema(schemas[name]!, model.exposure.read);
    if (listItem) schemas[`${name}ListItem`] = listItem;
    if (read) schemas[`${name}Read`] = read;
    readSchemas.set(model.key, {
      list: listItem ? `${name}ListItem` : name,
      read: read ? `${name}Read` : name,
      schemas,
      populate: populatePathsOf(model, entities, populateMaxDepth),
    });
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  // Hooks run by each operation, keyed by `<method> <path>`.
  const operationHooks = new Map<string, HookCall[]>();
  for (const route of routes) {
    const model = entities.find((candidate) => candidate.key === route.entity);
    if (!model || model.internal) continue;
    const path = openApiPath(route.path);
    tags.add(entityTag(model));
    (paths[path] ??= {})[route.method.toLowerCase()] = operationFor(model, route.operation, names.get(model.key)!, entities, readSchemas.get(model.key)!);
    operationHooks.set(`${route.method.toLowerCase()} ${path}`, route.hooks);
    const mode = model.file && files && route.operation === "read" ? resolveFileAccess(model, files).mode : "direct";
    if (mode !== "direct") {
      const filePath = `${openApiPath(`${entityRoutePath(model)}/[id]`)}/file`;
      (paths[filePath] ??= {}).get = fileOperation(model, names.get(model.key)!, mode === "signed");
      // Proxy downloads run the entity's read hooks; signed ones only check the signature.
      operationHooks.set(`get ${filePath}`, mode === "proxy" ? route.hooks : []);
    }
  }
  for (const doc of endpoints) {
    const method = doc.method.toLowerCase();
    const route = doc.override && routes.find((candidate) => candidate.entity === doc.override!.entity && candidate.operation === doc.override!.operation);
    const generatedPath = route ? openApiPath(route.path) : undefined;
    const generated = generatedPath ? paths[generatedPath]?.[method] : undefined;
    if (generatedPath && generated) {
      operationHooks.delete(`${method} ${generatedPath}`);
      delete paths[generatedPath]![method];
      if (Object.keys(paths[generatedPath]!).length === 0) delete paths[generatedPath];
    }
    const operation = generated ? overriddenOperation(doc, generated as Record<string, unknown>, schemas) : customOperation(doc, schemas);
    if (doc.projection) projectSuccessResponse(operation, doc.projection, schemas, generated !== undefined && doc.override?.operation === "list");
    if (doc.summary) operation.summary = doc.summary;
    if (doc.description) operation.description = doc.description;
    for (const tag of operation.tags as string[]) tags.add(tag);
    (paths[openApiPath(doc.path)] ??= {})[method] = operation;
    operationHooks.set(`${method} ${openApiPath(doc.path)}`, doc.hooks);
  }
  let bearer = false;
  for (const [key, calls] of operationHooks) {
    if (calls.length === 0) continue;
    const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    if (documentHooks(paths[path]![method] as Record<string, any>, calls, hooks)) bearer = true;
  }
  return {
    openapi: "3.1.0",
    info: { title: packageJson.name ?? "QuickService", version: packageJson.version ?? "0.0.0" },
    tags: [...tags].sort().map((name) => ({ name })),
    paths: sortKeys(
      Object.fromEntries(
        Object.entries(paths).map(([path, operations]) => [
          path,
          sortKeys(operations, (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)),
        ]),
      ),
    ),
    components: {
      schemas: sortKeys(schemas),
      ...(bearer ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } } : {}),
    },
  };
}
