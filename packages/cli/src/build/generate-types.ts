import type { AnyOptionSchema, EntityModel, EnumDeclarationInfo, FieldModel, NestedFieldModel, TypeDescriptor } from "@quickservicets/core";

/** Local names of the enum and alias declarations imported by the generated file, keyed by `<file>#<name>`. */
type EnumImports = Map<string, string>;

const declarationKey = (declaration: EnumDeclarationInfo) => `${declaration.file}#${declaration.name}`;

type Mode = "read" | "create" | "update";

function typeOf(descriptor: TypeDescriptor, indent: string, imports: EnumImports, mode: Mode): string {
  switch (descriptor.type) {
    case "string":
    case "ref":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "Date";
    case "enum": {
      // Enums without initializers are numbers at runtime, so their fields take the member names instead.
      const imported = descriptor.declaration && !descriptor.declaration.implicit ? imports.get(declarationKey(descriptor.declaration)) : undefined;
      return imported ?? descriptor.values.map((value) => JSON.stringify(value)).join(" | ");
    }
    case "array":
      return `Array<${typeOf(descriptor.items, indent, imports, mode)}>`;
    case "refArray":
      return mode === "update" ? "Array<string> | { add?: Array<string>; remove?: Array<string> }" : "Array<string>";
    case "object":
      return objectType(descriptor.fields, indent, imports, mode);
    case "json":
      return "unknown";
  }
}

/** A property line; `omittable` fields may be left out, and only optional fields also take `null`. */
function property(
  field: NestedFieldModel,
  optional: boolean,
  indent: string,
  imports: EnumImports,
  mode: Mode,
  omittable = optional,
): string {
  const type = typeOf(field, indent, imports, mode);
  return `${indent}${field.name}${omittable ? "?" : ""}: ${type}${optional ? " | null" : ""};`;
}

function objectType(fields: NestedFieldModel[], indent: string, imports: EnumImports, mode: Mode): string {
  const inner = `${indent}  `;
  // Nested objects are sent whole, so their own required fields apply in every mode.
  const nestedMode = mode === "update" ? "create" : mode;
  return `{\n${fields.map((field) => property(field, field.optional, inner, imports, nestedMode)).join("\n")}\n${indent}}`;
}

const pascalCase = (value: string) =>
  value.replace(/(^|-)([a-z0-9])/g, (_, __, char: string) => char.toUpperCase());

/** Type name of an entity; schema-bound entities sharing a type name with another schema get the schema prefix. */
export function entityTypeName(model: EntityModel, models: EntityModel[] = [model]): string {
  const shared = models.some((other) => other !== model && other.entityName === model.entityName);
  return shared && model.schema ? `${pascalCase(model.schema)}${model.entityName}` : model.entityName;
}

export function generateEntityType(model: EntityModel, models: EntityModel[] = [model], imports: EnumImports = new Map()): string {
  // Reference arrays are always returned, as [] when empty.
  const fields = model.fields.map((field: FieldModel) =>
    property(field, field.type !== "refArray" && (field.optional || field.hidden === true), "  ", imports, "read"),
  );
  return [
    `export type ${entityTypeName(model, models)} = {`,
    "  id: string;",
    "  createdAt: Date;",
    "  updatedAt: Date;",
    ...fields,
    "};",
  ].join("\n");
}

/** `<Entity>Create` and `<Entity>Update`: the fields a body may set; Create requires the ones without a default. */
export function generateInputTypes(model: EntityModel, models: EntityModel[] = [model], imports: EnumImports = new Map()): string {
  const name = entityTypeName(model, models);
  const create = model.fields
    .filter((field) => !field.readOnly)
    .map((field) =>
      property(field, field.optional, "  ", imports, "create", field.optional || field.default !== undefined || field.type === "refArray"),
    );
  const update = model.fields
    .filter((field) => !field.readOnly || field.readOnly === "unlessPatch")
    .map((field) => property(field, field.optional, "  ", imports, "update", true));
  return [`export type ${name}Create = {`, ...create, "};", "", `export type ${name}Update = {`, ...update, "};"].join("\n");
}

/**
 * `<Entity>References`: maps reference fields to `One`/`Many` of the referenced record type and its own references,
 * so populated reads are typed at every level. The derived sides of relations are marked, so `related` only takes
 * stored reference arrays.
 */
function generateReferencesType(model: EntityModel, models: EntityModel[]): string {
  const entries = model.fields.flatMap((field) => {
    if (field.type !== "ref" && field.type !== "refArray") return [];
    const target = models.find((candidate) => candidate.key === field.target);
    if (!target) return [];
    const type = entityTypeName(target, models);
    if (field.type === "ref") return [`  ${field.name}: One<${type}, ${type}References>;`];
    return [`  ${field.name}: Many<${type}, ${type}References${field.storage === "derived" ? ', "derived"' : ""}>;`];
  });
  const name = `${entityTypeName(model, models)}References`;
  return entries.length > 0 ? [`export type ${name} = {`, ...entries, "};"].join("\n") : `export type ${name} = Record<never, never>;`;
}

function repositoryLines(models: EntityModel[]): string[] {
  const line = (model: EntityModel, indent: string) => {
    const name = entityTypeName(model, models);
    if (model.system) return `${indent}${model.repoKey}: ReadRepository<${name}, ${name}References>;`;
    return `${indent}${model.repoKey}: Repository<${name}, ${name}References, ${name}Create, ${name}Update>;`;
  };
  const lines = models.filter((model) => !model.schemaKey).map((model) => line(model, "  "));
  const schemaKeys = [...new Set(models.flatMap((model) => (model.schemaKey ? [model.schemaKey] : [])))];
  for (const schemaKey of schemaKeys) {
    lines.push(`  ${schemaKey}: {`);
    lines.push(...models.filter((model) => model.schemaKey === schemaKey).map((model) => line(model, "    ")));
    lines.push("  };");
  }
  lines.push("  /** Runs `fn` in one database transaction; a call inside another transaction joins it. */");
  lines.push("  transaction<T>(fn: () => Promise<T>): Promise<T>;");
  return lines;
}

function declarationsOf(descriptor: TypeDescriptor): EnumDeclarationInfo[] {
  if (descriptor.type === "enum") return descriptor.declaration && !descriptor.declaration.implicit ? [descriptor.declaration] : [];
  if (descriptor.type === "array") return declarationsOf(descriptor.items);
  if (descriptor.type === "object") return descriptor.fields.flatMap(declarationsOf);
  return [];
}

/** One import per enum or alias declaration; repeated names get a numeric suffix (`Status2`). */
function enumImports(models: EntityModel[]): { imports: EnumImports; lines: string[] } {
  const taken = new Set(models.flatMap((model) => {
    const name = entityTypeName(model, models);
    return [name, `${name}Create`, `${name}Update`, `${name}References`, "Repository", "ReadRepository", "Many", "One", "GeneratedRepositories"];
  }));
  const imports: EnumImports = new Map();
  const lines: string[] = [];
  for (const declaration of models.flatMap((model) => model.fields.flatMap(declarationsOf))) {
    const key = declarationKey(declaration);
    if (imports.has(key)) continue;
    let local = declaration.name;
    for (let suffix = 2; taken.has(local); suffix++) local = `${declaration.name}${suffix}`;
    taken.add(local);
    imports.set(key, local);
    const specifier = local === declaration.name ? local : `${declaration.name} as ${local}`;
    lines.push(`import type { ${specifier} } from ${JSON.stringify(declaration.file.startsWith("@") ? declaration.file : `../${declaration.file}`)};`);
  }
  return { imports, lines };
}

/** The TypeScript type of a value an option schema accepts once parsed. */
export function optionValueType(schema: AnyOptionSchema): string {
  const { settings } = schema;
  switch (schema.kind) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "oneOf":
      return settings.values!.map((value) => JSON.stringify(value)).join(" | ");
    case "list": {
      const item = optionValueType(settings.item!);
      return /[ |]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      return `{ ${Object.entries(settings.shape!)
        .map(([key, child]) => `${JSON.stringify(key)}${child.settings.optional && !child.settings.hasDefault ? "?" : ""}: ${optionValueType(child)}`)
        .join("; ")} }`;
    case "provider":
      return "unknown";
    case "anyOf":
      return settings.members!.map((member) => optionValueType(member)).join(" | ");
    case "size":
      return "string | number";
    default:
      return "string";
  }
}

/** The `EnvVars` members of the declared variables: optional ones without a default may be undefined. */
export function envVarsLines(variables: readonly { name: string; schema: AnyOptionSchema }[]): string[] {
  return variables.map(({ name, schema }) => {
    const type = optionValueType(schema);
    return `    ${name}: ${schema.settings.optional && !schema.settings.hasDefault ? `${type} | undefined` : type};`;
  });
}

/** The write events of every entity that emits them, as `EventMap` entries typed with the entity's record. */
function eventMapLines(models: EntityModel[]): string[] {
  const emitting = models.filter((model) => !model.system);
  if (emitting.length === 0) return [];
  const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return [
    "  interface EventMap {",
    ...emitting.flatMap((model) =>
      (["created", "updated", "deleted"] as const).map((operation) => `    "${lowerFirst(model.entityName)}.${operation}": WriteEvent<${entityTypeName(model, models)}, "${operation}">;`),
    ),
    "  }",
  ];
}

export function generateTypesFile(allModels: EntityModel[], envVars: string[] = []): string {
  const models = allModels.filter((model) => !model.link);
  const { imports, lines } = enumImports(models);
  const repositories = repositoryLines(models);
  return [
    "// Generated by quickservicets build. Do not edit.",
    `import type { Many, One, ${models.some((model) => model.system) ? "ReadRepository, " : ""}Repository, WriteEvent } from "@quickservicets/core";`,
    ...lines,
    "",
    ...models.flatMap((model) => [
      generateEntityType(model, models, imports),
      "",
      // Records of system entities are written by the framework, so code gets no input types for them.
      ...(model.system ? [] : [generateInputTypes(model, models, imports), ""]),
      generateReferencesType(model, models),
      "",
    ]),
    "export interface GeneratedRepositories {",
    ...repositories,
    "}",
    "",
    'declare module "@quickservicets/core" {',
    "  interface Repositories extends GeneratedRepositories {}",
    ...(envVars.length > 0 ? ["  interface EnvVars {", ...envVars, "  }"] : ["  interface EnvVars {}"]),
    ...eventMapLines(models),
    "}",
    "",
  ].join("\n");
}

/** One queue of the project's `queues/` folder: its name and how `.generated/types.ts` imports its file. */
export interface QueueTypeEntry {
  name: string;
  specifier: string;
}

/** A queue entities publish their write events to, with the event types it receives. */
export interface PublishedQueueEntry {
  name: string;
  /** Event types like `user.created`. */
  types: readonly string[];
}

/**
 * The `QueuePayloads` entries of the declared queues, each typed with its file's payload, and of the queues entities
 * publish to, typed with the write events they receive (over the file's type, which may itself use them).
 */
export function queuePayloadLines(queues: readonly QueueTypeEntry[], published: readonly PublishedQueueEntry[] = []): string[] {
  const publishedNames = new Set(published.map((entry) => entry.name));
  const files = queues.filter((entry) => !publishedNames.has(entry.name));
  if (files.length === 0 && published.length === 0) return [];
  return [
    `import type { ${[...(files.length > 0 ? ["QueuePayloadOf"] : []), ...(published.length > 0 ? ["EventMap"] : [])].join(", ")} } from "@quickservicets/core";`,
    "",
    'declare module "@quickservicets/core" {',
    "  interface QueuePayloads {",
    ...files.map((entry) => `    ${JSON.stringify(entry.name)}: QueuePayloadOf<typeof import(${JSON.stringify(entry.specifier)}).default>;`),
    ...published.map((entry) => `    ${JSON.stringify(entry.name)}: ${entry.types.map((type) => `EventMap[${JSON.stringify(type)}]`).join(" | ")};`),
    "  }",
    "}",
    "",
  ];
}

/**
 * The `HttpServiceNames` entries of the config's `http.services`, so `http.service()` takes those names; nothing
 * without services.
 */
export function serviceNameLines(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  return ['declare module "@quickservicets/core" {', "  interface HttpServiceNames {", ...names.map((name) => `    ${JSON.stringify(name)}: true;`), "  }", "}", ""];
}
