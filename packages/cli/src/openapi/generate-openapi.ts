import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  listQueryFields,
  type CrudOperation,
  type CrudRouteEntry,
  type EntityModel,
  type HookDefinition,
  type NestedFieldModel,
  type TypeDescriptor,
} from "@quickservice/core";

export type JsonSchema = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema> };
}

export interface GenerateOpenApiOptions {
  models: EntityModel[];
  /** Generated CRUD routes (method, path, entity key and operation). */
  routes: CrudRouteEntry[];
  hooks?: ReadonlyMap<string, HookDefinition>;
  packageJson: { name?: string; version?: string };
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

const ERROR_DESCRIPTIONS: Record<number, string> = { 400: "Invalid request", 404: "Not found", 409: "Conflict" };

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

function withNull(schema: JsonSchema): JsonSchema {
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
    case "enum":
      return { type: "string", enum: [...descriptor.values] };
    case "ref":
      return { type: "string", format: "uuid" };
    case "refArray":
      return { type: "array", items: { type: "string", format: "uuid" } };
    case "array":
      return { type: "array", items: descriptorSchema(descriptor.items, visible, mode) };
    case "object":
      return objectSchema(descriptor.fields, visible, mode);
  }
}

function fieldSchema(field: NestedFieldModel, visible: (field: NestedFieldModel) => boolean, mode: WriteMode | "response"): JsonSchema {
  const schema = descriptorSchema(field, visible, mode);
  const isArray = field.type === "array" || field.type === "refArray";
  if (field.minLength !== undefined) schema[isArray ? "minItems" : "minLength"] = field.minLength;
  if (field.maxLength !== undefined) schema[isArray ? "maxItems" : "maxLength"] = field.maxLength;
  if (field.min !== undefined) schema.minimum = field.min;
  if (field.max !== undefined) schema.maximum = field.max;
  if (field.format) schema.format = field.format === "url" ? "uri" : field.format;
  if (field.default !== undefined) schema.default = field.default;
  return field.optional ? withNull(schema) : schema;
}

function isRequired(field: NestedFieldModel, mode: WriteMode | "response"): boolean {
  if (field.optional || mode === "update") return false;
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

/** The response schema: system fields and every field that is not `@hidden`. */
export function responseSchema(model: EntityModel): JsonSchema {
  const visible = (field: NestedFieldModel) => !field.hidden;
  const shown = model.fields.filter(visible);
  return {
    type: "object",
    properties: {
      ...SYSTEM_PROPERTIES,
      ...Object.fromEntries(shown.map((field) => [field.name, fieldSchema(field, visible, "response")])),
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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: JsonSchema) => ({ "application/json": { schema } });

function errorResponses(codes: number[]): Record<string, unknown> {
  return Object.fromEntries(codes.map((code) => [String(code), { description: ERROR_DESCRIPTIONS[code], content: json(ref("Error")) }]));
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

function operationFor(model: EntityModel, operation: CrudOperation, name: string, models: EntityModel[]): Record<string, unknown> {
  const unique = model.fields.some((field) => field.unique);
  const conflict = unique ? [409] : [];
  const record = { content: json(ref(name)) };
  const body = (schema: string) => ({ required: true, content: json(ref(schema)) });
  const base = { tags: [entityTag(model)], operationId: `${operation}${name}` };
  switch (operation) {
    case "list":
      return {
        ...base,
        parameters: listParameters(model),
        responses: {
          "200": {
            description: `A page of ${model.name}`,
            content: json({
              type: "object",
              required: ["data", "total", "limit", "offset"],
              properties: {
                data: { type: "array", items: ref(name) },
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
      return { ...base, parameters: [ID_PARAMETER], responses: { "200": { description: `The ${model.entityName}`, ...record }, ...errorResponses([404]) } };
    case "create":
      return {
        ...base,
        requestBody: body(`${name}Create`),
        responses: { "201": { description: `The created ${model.entityName}`, ...record }, ...errorResponses([400, ...conflict]) },
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
        responses: { "200": { description: `The replaced ${model.entityName}`, ...record }, ...errorResponses([400, 404, ...conflict]) },
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

function sortKeys<T>(record: Record<string, T>, compare?: (a: string, b: string) => number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (compare ? compare(a, b) : a < b ? -1 : a > b ? 1 : 0)));
}

/** Builds the OpenAPI 3.1 document of the entities and their generated CRUD routes. */
export function generateOpenApi({ models, routes, packageJson }: GenerateOpenApiOptions): OpenApiDocument {
  const entities = models.filter((model) => !model.link);
  const names = componentNames(entities);
  const schemas: Record<string, JsonSchema> = { Error: ERROR_SCHEMA };
  for (const model of entities) {
    const name = names.get(model.key)!;
    schemas[name] = responseSchema(model);
    schemas[`${name}Create`] = writeSchema(model, "create");
    schemas[`${name}Replace`] = writeSchema(model, "replace");
    schemas[`${name}Update`] = writeSchema(model, "update");
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const route of routes) {
    const model = entities.find((candidate) => candidate.key === route.entity);
    if (!model || model.internal) continue;
    const path = openApiPath(route.path);
    tags.add(entityTag(model));
    (paths[path] ??= {})[route.method.toLowerCase()] = operationFor(model, route.operation, names.get(model.key)!, entities);
  }
  return {
    openapi: "3.1.0",
    info: { title: packageJson.name ?? "quickservice", version: packageJson.version ?? "0.0.0" },
    tags: [...tags].sort().map((name) => ({ name })),
    paths: sortKeys(
      Object.fromEntries(
        Object.entries(paths).map(([path, operations]) => [
          path,
          sortKeys(operations, (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)),
        ]),
      ),
    ),
    components: { schemas: sortKeys(schemas) },
  };
}
