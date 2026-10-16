import type { EntityModel, EnumDeclarationInfo, FieldModel, NestedFieldModel, TypeDescriptor } from "@quickservice/core";

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
 * so populated reads are typed at every level.
 */
function generateReferencesType(model: EntityModel, models: EntityModel[]): string {
  const entries = model.fields.flatMap((field) => {
    if (field.type !== "ref" && field.type !== "refArray") return [];
    const target = models.find((candidate) => candidate.key === field.target);
    if (!target) return [];
    const type = entityTypeName(target, models);
    return [`  ${field.name}: ${field.type === "refArray" ? "Many" : "One"}<${type}, ${type}References>;`];
  });
  const name = `${entityTypeName(model, models)}References`;
  return entries.length > 0 ? [`export type ${name} = {`, ...entries, "};"].join("\n") : `export type ${name} = Record<never, never>;`;
}

function repositoryLines(models: EntityModel[]): string[] {
  const line = (model: EntityModel, indent: string) => {
    const name = entityTypeName(model, models);
    return `${indent}${model.repoKey}: Repository<${name}, ${name}References, ${name}Create, ${name}Update>;`;
  };
  const lines = models.filter((model) => !model.schemaKey).map((model) => line(model, "  "));
  const schemaKeys = [...new Set(models.flatMap((model) => (model.schemaKey ? [model.schemaKey] : [])))];
  for (const schemaKey of schemaKeys) {
    lines.push(`  ${schemaKey}: {`);
    lines.push(...models.filter((model) => model.schemaKey === schemaKey).map((model) => line(model, "    ")));
    lines.push("  };");
  }
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
    return [name, `${name}Create`, `${name}Update`, `${name}References`, "Repository", "Many", "One", "GeneratedRepositories"];
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
    lines.push(`import type { ${specifier} } from ${JSON.stringify(`../${declaration.file}`)};`);
  }
  return { imports, lines };
}

export function generateTypesFile(allModels: EntityModel[]): string {
  const models = allModels.filter((model) => !model.link);
  const { imports, lines } = enumImports(models);
  const repositories = repositoryLines(models);
  return [
    "// Generated by quickservice build. Do not edit.",
    'import type { Many, One, Repository } from "@quickservice/core";',
    ...lines,
    "",
    ...models.flatMap((model) => [
      generateEntityType(model, models, imports),
      "",
      generateInputTypes(model, models, imports),
      "",
      generateReferencesType(model, models),
      "",
    ]),
    "export interface GeneratedRepositories {",
    ...repositories,
    "}",
    "",
    'declare module "@quickservice/core" {',
    "  interface Repositories extends GeneratedRepositories {}",
    "}",
    "",
  ].join("\n");
}
