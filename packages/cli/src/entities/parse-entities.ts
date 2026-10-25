import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  builtInFileEntity,
  featureDir,
  NATIVE_FEATURES_DIR,
  type ResolvedFeature,
  jobRunEntity,
  FILE_BASE_FIELDS,
  hiddenPathsFor,
  parseFieldPaths,
  populatePathErrors,
  SYSTEM_FIELDS,
  type EntityModel,
  type Exposure,
  type ReadOperation,
  type FieldModel,
  type NestedFieldModel,
  type OnDeleteAction,
  type TypeDescriptor,
} from "@quickservice/core";
import { hasJobFiles } from "../build/feature-files.ts";
import { EntityParseError } from "./errors.ts";
import { withContributedEntities } from "./feature-entities.ts";
import { applyEntityTags, isBuiltInEntityTag, type EntityTagTarget } from "./entity-tags.ts";
import { applyFieldTags, isFieldTag } from "./field-tags.ts";
import { useFeatureTags } from "./feature-tags.ts";
import { isBuiltInEndpointTag } from "../hooks/endpoint-tags.ts";
import { findTag, readTags, type DocTag } from "./jsdoc.ts";
import { pairRelations } from "./relations.ts";
import { deriveCollectionName, isValidCollectionName, toCamelCase, toSnakeCase } from "./naming.ts";

const ENTITY_FILE = /^[A-Z][A-Za-z0-9]*\.ts$/;
const ON_DELETE_ACTIONS: readonly OnDeleteAction[] = ["restrict", "cascade", "setNull"];

interface EntitySource {
  file: string;
  relativeFile: string;
  key: string;
  entityName: string;
  /** Folder inside `/entities`, which sets the schema unless `@schema` overrides it. */
  folder?: string;
  /** Set when the file name is not PascalCase, which only shared enum files may use. */
  invalidName?: true;
  /** The key of the feature whose folder holds the file. */
  feature?: string;
}

type EntityDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

interface ParseContext {
  checker: ts.TypeChecker;
  source: EntitySource;
  sourcesByFile: Map<string, EntitySource>;
  projectRoot: string;
}

/** The entities of the project and of its enabled features, with the override lines of project entities replacing feature ones. */
export interface ProjectModels {
  models: EntityModel[];
  overrides: string[];
}

/** The entities of `/entities` and of the given features' entity folders, and their link entities. */
export function parseEntities(projectRoot: string, features: readonly ResolvedFeature[] = []): EntityModel[] {
  return parseSources(projectRoot, features).models;
}

/** The built-in tag a feature tag's name would shadow, described for an error. */
export function builtInTagOwner(name: string): string | undefined {
  return isBuiltInEntityTag(name) || isFieldTag(name) || isBuiltInEndpointTag(name) ? `the built-in tag @${name}` : undefined;
}

function parseSources(projectRoot: string, features: readonly ResolvedFeature[]): ProjectModels {
  const restore = useFeatureTags(features, builtInTagOwner);
  try {
    return parseSourcesWithTags(projectRoot, features);
  } finally {
    restore();
  }
}

function parseSourcesWithTags(projectRoot: string, features: readonly ResolvedFeature[]): ProjectModels {
  const entitiesDir = join(projectRoot, "entities");
  const projectFiles = listEntitySources(projectRoot, entitiesDir);
  const { sources: featureFiles, overrides } = featureEntitySources(projectRoot, features, projectFiles);
  const files = [...projectFiles, ...featureFiles];
  const program = ts.createProgram(
    files.map((source) => source.file),
    {
      strict: true,
      noEmit: true,
      noLib: true,
      types: [],
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    },
  );
  // Creating the checker binds every source file, which sets the parent pointers the parser relies on.
  const checker = program.getTypeChecker();
  // Files that only export enums or string unions are shared by entities, not entities themselves.
  const sources = files.filter((source) => !declaresOnlyEnums(program.getSourceFile(source.file)));
  const misnamed = sources.find((source) => source.invalidName);
  if (misnamed) throw new EntityParseError(`${misnamed.relativeFile}: entity file names must be PascalCase (e.g. User.ts)`);
  const sourcesByFile = new Map(sources.map((source) => [source.file, source]));

  const models = sources.map((source) => {
    const model = parseEntity(program, { checker, source, sourcesByFile, projectRoot });
    return source.feature ? { ...model, feature: source.feature } : model;
  });
  assertNoFeatureClashes(models);
  assertUniqueCollectionNames(models, sources);
  const links = pairRelations(models);
  assertUniqueTableNames(models, links, sources);
  models.forEach((model, index) => {
    for (const field of model.fields) {
      if (field.storage === "derived" && (field.unique || field.index)) {
        throw new EntityParseError(
          `${sources[index]!.relativeFile}: field "${field.name}" is the derived side of a relation and cannot use @unique or @index`,
        );
      }
    }
  });
  const known = withBuiltInEntities(models);
  models.forEach((model, index) => {
    for (const field of model.fields) {
      if (!field.fileLimits && !field.keepFile) continue;
      if ((field.type === "ref" || field.type === "refArray") && known.find((candidate) => candidate.key === field.target)?.file) continue;
      const limits = field.fileLimits ?? {};
      const tag = field.keepFile
        ? "@keepFile"
        : limits.maxSize !== undefined
          ? "@maxSize"
          : limits.maxTotalSize !== undefined
            ? "@maxTotalSize"
            : "@accept";
      throw new EntityParseError(
        `${sources[index]!.relativeFile}: field "${field.name}" has invalid ${tag}: only applies to references to file entities`,
      );
    }
  });
  models.forEach((model, index) => {
    for (const path of new Set([...(model.populate?.list ?? []), ...(model.populate?.read ?? [])])) {
      const [error] = populatePathErrors(model, withBuiltInEntities(models), path, Number.POSITIVE_INFINITY);
      if (error) throw new EntityParseError(`${sources[index]!.relativeFile}: invalid @populate: ${error}`);
    }
  });
  return { models: [...models, ...links], overrides };
}

/** How the build names a file of a feature folder: project-relative, or through the core package for a native. */
export function featureFileName(projectRoot: string, file: string): string {
  const inNative = relative(NATIVE_FEATURES_DIR, file);
  if (!inNative.startsWith("..") && !inNative.startsWith(sep) && !/^[A-Za-z]:/.test(inNative)) {
    return `@quickservice/core/features/${inNative.split(sep).join("/")}`;
  }
  return relative(projectRoot, file).split(sep).join("/");
}

/** The entity files of the features' `entities` folders; a project file of the same name replaces a feature's. */
function featureEntitySources(
  projectRoot: string,
  features: readonly ResolvedFeature[],
  projectSources: EntitySource[],
): { sources: EntitySource[]; overrides: string[] } {
  const projectByKey = new Map(projectSources.map((source) => [source.key, source]));
  const owners = new Map<string, EntitySource>();
  const sources: EntitySource[] = [];
  const overrides: string[] = [];
  for (const feature of features) {
    const entities = feature.definition.entities;
    if (typeof entities !== "string") continue;
    const dir = resolve(featureDir(feature, projectRoot), entities);
    for (const source of listEntitySources(projectRoot, dir)) {
      const named: EntitySource = { ...source, relativeFile: featureFileName(projectRoot, source.file), feature: feature.key };
      const replacement = projectByKey.get(named.key);
      if (replacement && !named.invalidName) {
        overrides.push(entityOverrideLine(replacement.relativeFile, named.key, feature.key));
        continue;
      }
      const previous = owners.get(named.key);
      if (previous && !named.invalidName) {
        throw new EntityParseError(`Features ${previous.feature} and ${feature.key} both contribute the entity ${named.key} (${previous.relativeFile} and ${named.relativeFile})`);
      }
      if (!named.invalidName) owners.set(named.key, named);
      sources.push(named);
    }
  }
  return { sources, overrides };
}

/** Fails when entity files of two features use the same collection or table name in one schema. */
function assertNoFeatureClashes(models: EntityModel[]): void {
  const seen = new Map<string, string>();
  for (const model of models) {
    if (!model.feature) continue;
    for (const [kind, value] of [["collection name", model.name], ["table name", model.tableName]] as const) {
      const id = `${kind}\u0000${model.schema ?? ""}\u0000${value}`;
      const owner = seen.get(id);
      if (owner && owner !== model.feature) throw new EntityParseError(`Features ${owner} and ${model.feature} both contribute the ${kind} "${value}"`);
      seen.set(id, model.feature);
    }
  }
}

/** The line the build prints when a project entity file replaces a feature's entity. */
export const entityOverrideLine = (projectFile: string, name: string, key: string) => `Override: ${projectFile} replaces ${name} from ${key}`;

/** Adds the built-in `File` and `Media` entities unless `/entities` defines them. */
export function withBuiltInEntities(models: EntityModel[]): EntityModel[] {
  const builtIns = (["file", "media"] as const)
    .map((base) => builtInFileEntity(base))
    .filter((builtIn) => !models.some((model) => model.key === builtIn.key));
  return [...models, ...builtIns];
}

/** Adds the built-in `JobRun` entity, failing when a project entity takes its name, repository or table. */
export function withJobRunEntity(models: EntityModel[]): EntityModel[] {
  const jobRun = jobRunEntity();
  const conflict = models.find(
    (model) =>
      model.key === jobRun.key ||
      (!model.schema && (model.tableName === jobRun.tableName || (!model.schemaKey && model.repoKey === jobRun.repoKey))),
  );
  if (conflict) {
    throw new EntityParseError(`entities/${conflict.key}.ts: entity ${conflict.entityName} conflicts with the built-in JobRun entity (collection job-runs) that stores job runs`);
  }
  return [...models, jobRun];
}

/**
 * Every entity of the project: the ones in `/entities`, the ones the enabled features contribute, their link
 * entities, the built-in file entities, and the built-in `JobRun` entity when the project has jobs.
 */
export function parseProjectEntities(projectRoot: string, features: readonly ResolvedFeature[] = []): EntityModel[] {
  return parseProjectModels(projectRoot, features).models;
}

/** `parseProjectEntities` with the override lines of project entities replacing feature entities. */
export function parseProjectModels(projectRoot: string, features: readonly ResolvedFeature[] = []): ProjectModels {
  const parsed = parseSources(projectRoot, features);
  const contributed = withContributedEntities(parsed.models, features);
  const models = withBuiltInEntities(contributed.models);
  return {
    models: hasJobFiles(projectRoot, features) ? withJobRunEntity(models) : models,
    overrides: [...parsed.overrides, ...contributed.overrides],
  };
}

function listEntitySources(projectRoot: string, entitiesDir: string): EntitySource[] {
  const sources: EntitySource[] = [];
  const visit = (dir: string, folder?: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = resolve(dir, entry);
      const relativeFile = relative(projectRoot, file);
      if (statSync(file).isDirectory()) {
        if (folder !== undefined) {
          throw new EntityParseError(`${relativeFile}: entities may only be nested one folder deep`);
        }
        visit(file, entry);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const entityName = entry.slice(0, -3);
      sources.push({
        file,
        relativeFile,
        key: folder ? `${folder}/${entityName}` : entityName,
        entityName,
        folder,
        ...(ENTITY_FILE.test(entry) ? {} : { invalidName: true as const }),
      });
    }
  };
  visit(entitiesDir);
  return sources;
}

function parseEntity(program: ts.Program, context: ParseContext): EntityModel {
  const { source } = context;
  const sourceFile = program.getSourceFile(source.file);
  if (!sourceFile) throw new EntityParseError(`${source.relativeFile}: file could not be read`);
  const [syntaxError] = program.getSyntacticDiagnostics(sourceFile);
  if (syntaxError) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(syntaxError.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(syntaxError.messageText, " ");
    throw new EntityParseError(`${source.relativeFile}:${line + 1}:${character + 1}: ${message}`);
  }

  const declaration = findEntityDeclaration(sourceFile, source);
  const shape = declarationShape(declaration, source);
  const name =
    shape.base === "media" && source.entityName === "Media" && !findTag(declaration, "collection")
      ? "media"
      : resolveCollectionName(declaration, source);
  const schema = resolveSchema(declaration, source);
  const tagTarget: EntityTagTarget = { hooks: [], overrideHooks: "inherit", internal: false };
  applyEntityTags(tagTarget, readTags(declaration), { relativeFile: source.relativeFile });
  const { fieldSelections = [], ...tags } = tagTarget;
  if (tags.storageName && !shape.base) {
    throw new EntityParseError(`${source.relativeFile}: invalid @storage: ${source.entityName} is not a file entity`);
  }
  if (tags.fileAccess && !shape.base) {
    throw new EntityParseError(`${source.relativeFile}: invalid @access: ${source.entityName} is not a file entity`);
  }
  if (tags.fileLimits && !shape.base) {
    const tag = tags.fileLimits.maxSize !== undefined ? "@maxSize" : "@accept";
    throw new EntityParseError(`${source.relativeFile}: invalid ${tag}: ${source.entityName} is not a file entity`);
  }
  const model: EntityModel = {
    key: source.key,
    entityName: source.entityName,
    schema,
    ...(schema ? { schemaKey: toCamelCase(schema) } : {}),
    name,
    repoKey: toCamelCase(name),
    tableName: toSnakeCase(name),
    fields: withFileBase(parseFields(shape.members, context), shape.base, source),
    ...(shape.base ? { file: { base: shape.base } } : {}),
    ...tags,
    exposure: { list: { include: [], exclude: [] }, read: { include: [], exclude: [] } },
  };
  if ((model.schemaKey ?? model.repoKey) === "transaction") {
    throw new EntityParseError(`${source.relativeFile}: the repository key transaction is reserved; rename the entity or set @collection`);
  }
  model.exposure = {
    list: exposureFor(model, "list", fieldSelections, source),
    read: exposureFor(model, "read", fieldSelections, source),
  };
  return model;
}

/** Whether a file exports enums or string-literal union aliases and nothing else. */
function declaresOnlyEnums(sourceFile: ts.SourceFile | undefined): boolean {
  if (!sourceFile) return false;
  const exported = sourceFile.statements.filter((statement) => isExported(statement) || ts.isExportAssignment(statement));
  return (
    exported.length > 0 &&
    exported.every(
      (statement) =>
        ts.isEnumDeclaration(statement) ||
        (ts.isTypeAliasDeclaration(statement) &&
          ts.isUnionTypeNode(statement.type) &&
          statement.type.types.every((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))),
    )
  );
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function exportedTypeDeclarations(sourceFile: ts.SourceFile): EntityDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is EntityDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && isExported(statement),
  );
}

function findEntityDeclaration(sourceFile: ts.SourceFile, source: EntitySource): EntityDeclaration {
  const exportedTypes = exportedTypeDeclarations(sourceFile);
  if (exportedTypes.length !== 1) {
    throw new EntityParseError(
      `${source.relativeFile}: must export exactly one entity type named ${source.entityName} (found ${exportedTypes.length})`,
    );
  }
  const declaration = exportedTypes[0]!;
  if (declaration.name.text !== source.entityName) {
    throw new EntityParseError(
      `${source.relativeFile}: exported type ${declaration.name.text} must be named ${source.entityName}`,
    );
  }
  return declaration;
}

type FileBaseKind = "file" | "media";

/** Whether `name` refers to `File` or `Media` imported from @quickservice/core in this file. */
function coreFileBase(name: string, sourceFile: ts.SourceFile): FileBaseKind | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "@quickservice/core") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "File") return "file";
      if (imported === "Media") return "media";
    }
  }
  return undefined;
}

interface DeclarationShape {
  members: ts.TypeElement[];
  base?: FileBaseKind;
}

function declarationShape(declaration: EntityDeclaration, source: EntitySource): DeclarationShape {
  const sourceFile = declaration.getSourceFile();
  if (ts.isInterfaceDeclaration(declaration)) {
    let base: FileBaseKind | undefined;
    for (const clause of declaration.heritageClauses ?? []) {
      for (const type of clause.types) {
        const found = ts.isIdentifier(type.expression) ? coreFileBase(type.expression.text, sourceFile) : undefined;
        if (!found) throw new EntityParseError(`${source.relativeFile}: ${source.entityName} can only extend File or Media`);
        base = found;
      }
    }
    return { members: [...declaration.members], base };
  }
  if (ts.isTypeLiteralNode(declaration.type)) return { members: [...declaration.type.members] };
  if (ts.isIntersectionTypeNode(declaration.type)) {
    const shape: DeclarationShape = { members: [] };
    for (const part of declaration.type.types) {
      if (ts.isTypeLiteralNode(part)) shape.members.push(...part.members);
      else if (ts.isTypeReferenceNode(part) && ts.isIdentifier(part.typeName) && coreFileBase(part.typeName.text, sourceFile)) {
        shape.base = coreFileBase(part.typeName.text, sourceFile);
      } else {
        throw new EntityParseError(`${source.relativeFile}: type ${source.entityName} can only combine File or Media with an object literal type`);
      }
    }
    return shape;
  }
  throw new EntityParseError(`${source.relativeFile}: type ${source.entityName} must be an object literal type`);
}

/** File entities get the base fields first; redeclaring one of them is an error. */
function withFileBase(fields: FieldModel[], base: FileBaseKind | undefined, source: EntitySource): FieldModel[] {
  if (!base) return fields;
  const baseNames = new Set(FILE_BASE_FIELDS.map((field) => field.name));
  const redeclared = fields.find((field) => baseNames.has(field.name));
  if (redeclared) {
    throw new EntityParseError(`${source.relativeFile}: field "${redeclared.name}" is a base field of ${base === "file" ? "File" : "Media"} and cannot be redeclared`);
  }
  return [...FILE_BASE_FIELDS.map((field) => ({ ...field })), ...fields];
}

function resolveCollectionName(declaration: EntityDeclaration, source: EntitySource): string {
  const tag = findTag(declaration, "collection");
  if (!tag) return deriveCollectionName(source.entityName);
  const name = tag.text;
  if (!isValidCollectionName(name)) {
    throw new EntityParseError(`${source.relativeFile}: @collection "${name}" must match ^[a-z][a-z0-9-]*$`);
  }
  return name;
}

function exposureFor(
  model: EntityModel,
  operation: ReadOperation,
  selections: NonNullable<EntityTagTarget["fieldSelections"]>,
  source: EntitySource,
): Exposure {
  const hidden = hiddenPathsFor(model.fields, operation);
  const selection = selections.find((candidate) => candidate.operations.includes(operation));
  if (!selection) {
    return { include: [...SYSTEM_FIELDS, ...model.fields.map((field) => field.name)], exclude: hidden };
  }
  const parsed = parseFieldPaths(model, selection.paths);
  if (!parsed.ok) {
    throw new EntityParseError(`${source.relativeFile}: invalid @fields: unknown path ${parsed.invalid.join(", ")}`);
  }
  for (const path of parsed.paths) {
    const conflict = hidden.find((hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}.`));
    if (conflict) {
      throw new EntityParseError(
        `${source.relativeFile}: entity ${model.entityName} exposes "${path}" in @fields but it is hidden on ${operation}`,
      );
    }
  }
  return { include: parsed.paths, exclude: hidden };
}

function resolveSchema(declaration: EntityDeclaration, source: EntitySource): string | null {
  const schema = findTag(declaration, "schema")?.text ?? source.folder ?? null;
  if (schema !== null && !isValidCollectionName(schema)) {
    throw new EntityParseError(`${source.relativeFile}: schema "${schema}" must match ^[a-z][a-z0-9-]*$`);
  }
  return schema;
}

function parseFields(members: readonly ts.TypeElement[], context: ParseContext): FieldModel[] {
  const { source } = context;
  return members.map((member) => {
    const field = parseMember(member, "", true, context);
    if ((SYSTEM_FIELDS as readonly string[]).includes(field.name)) {
      throw new EntityParseError(
        `${source.relativeFile}: field "${field.name}" is a system field added to every entity and cannot be declared`,
      );
    }
    const storage = field.type === "refArray" ? "relation" : field.type === "array" || field.type === "object" ? "json" : "column";
    return { ...field, storage };
  });
}

function parseMember(member: ts.TypeElement, prefix: string, topLevel: boolean, context: ParseContext): NestedFieldModel {
  const { source } = context;
  if (!ts.isPropertySignature(member) || !member.type) {
    throw new EntityParseError(`${source.relativeFile}: only typed properties are supported in ${source.entityName}`);
  }
  const name = member.name.getText();
  const path = `${prefix}${name}`;
  const optional = member.questionToken !== undefined;
  const descriptor = mapType(member.type, path, topLevel, context);
  if (descriptor.type === "ref") {
    descriptor.onDelete = parseOnDelete(member, path, optional, source);
  }
  if (descriptor.type === "refArray") {
    descriptor.onDelete = parseArrayOnDelete(member, path, source);
  }
  const field: NestedFieldModel = { name, ...descriptor, optional };
  applyFieldTags(field, withEnumDefaults(descriptor, readTags(member)), { relativeFile: source.relativeFile, path, topLevel });
  return field;
}

function parseOnDelete(member: ts.PropertySignature, path: string, optional: boolean, source: EntitySource): OnDeleteAction {
  const tag = findTag(member, "onDelete");
  if (!tag) return "restrict";
  const value = tag.text;
  if (!(ON_DELETE_ACTIONS as readonly string[]).includes(value)) {
    throw new EntityParseError(
      `${source.relativeFile}: field "${path}" has invalid @onDelete "${value}" (use restrict, cascade or setNull)`,
    );
  }
  if (value === "setNull" && !optional) {
    throw new EntityParseError(`${source.relativeFile}: field "${path}" must be optional to use @onDelete setNull`);
  }
  return value as OnDeleteAction;
}

const ARRAY_ON_DELETE_ACTIONS = ["pull", "restrict", "cascade"] as const;

function parseArrayOnDelete(member: ts.PropertySignature, path: string, source: EntitySource): "pull" | "restrict" | "cascade" {
  const tag = findTag(member, "onDelete");
  if (!tag) return "pull";
  if (!(ARRAY_ON_DELETE_ACTIONS as readonly string[]).includes(tag.text)) {
    throw new EntityParseError(
      `${source.relativeFile}: field "${path}" has invalid @onDelete "${tag.text}" (use pull, restrict or cascade)`,
    );
  }
  return tag.text as "pull" | "restrict" | "cascade";
}

function unsupported(typeNode: ts.TypeNode, path: string, source: EntitySource): EntityParseError {
  return new EntityParseError(`${source.relativeFile}: field "${path}" has unsupported type "${typeNode.getText()}"`);
}

function mapType(typeNode: ts.TypeNode, path: string, topLevel: boolean, context: ParseContext): TypeDescriptor {
  const { source } = context;
  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
  }
  if (ts.isParenthesizedTypeNode(typeNode)) return mapType(typeNode.type, path, topLevel, context);
  if (ts.isUnionTypeNode(typeNode)) return mapEnum(typeNode, path, source);
  if (ts.isArrayTypeNode(typeNode)) {
    const reference = topLevel ? referenceArrayOf(typeNode.elementType, context) : undefined;
    if (reference) return reference;
    return { type: "array", items: mapType(typeNode.elementType, path, false, context) };
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return { type: "object", fields: typeNode.members.map((member) => parseMember(member, `${path}.`, false, context)) };
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    const args = typeNode.typeArguments ?? [];
    if (name === "Date" && args.length === 0) return { type: "date" };
    if (name === "Array" && args.length === 1) {
      const reference = topLevel ? referenceArrayOf(args[0]!, context) : undefined;
      if (reference) return reference;
      return { type: "array", items: mapType(args[0]!, path, false, context) };
    }
    const named = args.length === 0 ? namedEnumOf(typeNode, path, context) : undefined;
    if (named) return named;
    const target = resolveEntityReference(typeNode, context);
    if (target) {
      if (!topLevel) {
        throw new EntityParseError(
          `${source.relativeFile}: field "${path}" references an entity, which is only supported in top-level fields`,
        );
      }
      return { type: "ref", target: target.key, onDelete: "restrict" };
    }
  }
  throw unsupported(typeNode, path, source);
}

function referenceArrayOf(element: ts.TypeNode, context: ParseContext): TypeDescriptor | undefined {
  const inner = ts.isParenthesizedTypeNode(element) ? element.type : element;
  if (!ts.isTypeReferenceNode(inner)) return undefined;
  const target = resolveEntityReference(inner, context);
  return target ? { type: "refArray", target: target.key, onDelete: "pull" } : undefined;
}

function resolveEntityReference(typeNode: ts.TypeReferenceNode, context: ParseContext): EntitySource | undefined {
  if (typeNode.typeArguments?.length) return undefined;
  if (ts.isIdentifier(typeNode.typeName)) {
    const base = coreFileBase(typeNode.typeName.text, typeNode.getSourceFile());
    if (base) {
      // References to core File/Media target the built-in entity, or the project's own File.ts/Media.ts.
      const key = base === "file" ? "File" : "Media";
      return { file: "", relativeFile: "", key, entityName: key };
    }
  }
  let symbol = context.checker.getSymbolAtLocation(typeNode.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !(ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) return undefined;
  const target = context.sourcesByFile.get(resolve(declaration.getSourceFile().fileName));
  if (!target || declaration.name.text !== target.entityName || !isExported(declaration)) return undefined;
  return target;
}

/** Member names and values of named enums, used to read `@default <Enum>.<member>`. */
const enumMembers = new WeakMap<TypeDescriptor, { names: string[]; values: Map<string, string> }>();

const stringLiteralsOf = (union: ts.UnionTypeNode): string[] | undefined => {
  const values = union.types.map((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : undefined,
  );
  return values.every((value) => value !== undefined) ? (values as string[]) : undefined;
};

/** Maps a reference to an exported string `enum` or string-literal union alias to an enum field. */
function namedEnumOf(typeNode: ts.TypeReferenceNode, path: string, context: ParseContext): TypeDescriptor | undefined {
  const { source } = context;
  let symbol = context.checker.getSymbolAtLocation(typeNode.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return undefined;
  const isUnionAlias =
    ts.isTypeAliasDeclaration(declaration) &&
    !declaration.typeParameters &&
    ts.isUnionTypeNode(declaration.type) &&
    stringLiteralsOf(declaration.type) !== undefined;
  if (!ts.isEnumDeclaration(declaration) && !isUnionAlias) return undefined;
  const name = (declaration as ts.EnumDeclaration | ts.TypeAliasDeclaration).name.text;
  const fail = (reason: string) => new EntityParseError(`${source.relativeFile}: field "${path}" uses ${reason}`);
  if (!isExported(declaration)) throw fail(`${name}, which must be exported`);
  const file = featureFileName(context.projectRoot, resolve(declaration.getSourceFile().fileName));
  if (!ts.isEnumDeclaration(declaration)) {
    return { type: "enum", values: stringLiteralsOf((declaration as ts.TypeAliasDeclaration).type as ts.UnionTypeNode)!, declaration: { name, file } };
  }
  const members = declaration.members.map((member) => ({ name: member.name.getText(), initializer: member.initializer }));
  const implicit = members.every((member) => member.initializer === undefined);
  if (!implicit && !members.every((member) => member.initializer && ts.isStringLiteralLike(member.initializer))) {
    throw fail(`enum ${name}, whose members must all have string values or all have none`);
  }
  const values = members.map((member) => (implicit ? member.name : (member.initializer as ts.StringLiteralLike).text));
  const repeated = values.find((value, index) => values.indexOf(value) !== index);
  if (repeated !== undefined) throw fail(`enum ${name}, which repeats the value "${repeated}"`);
  const descriptor: TypeDescriptor = { type: "enum", values, declaration: { name, file, ...(implicit ? { implicit: true as const } : {}) } };
  enumMembers.set(descriptor, {
    names: [name, typeNode.typeName.getText()],
    values: new Map(members.map((member, index) => [member.name, values[index]!])),
  });
  return descriptor;
}

/** Rewrites `@default <Enum>.<member>` of a named enum field to the member's value; anything else is left as written. */
function withEnumDefaults(descriptor: TypeDescriptor, tags: DocTag[]): DocTag[] {
  const members = enumMembers.get(descriptor);
  if (!members) return tags;
  return tags.map((tag) => {
    const match = tag.name === "default" ? /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(tag.text) : null;
    const value = match && members.names.includes(match[1]!) ? members.values.get(match[2]!) : undefined;
    return value === undefined ? tag : { ...tag, text: JSON.stringify(value) };
  });
}

function mapEnum(typeNode: ts.UnionTypeNode, path: string, source: EntitySource): TypeDescriptor {
  const values = typeNode.types.map((member) => {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) return member.literal.text;
    throw new EntityParseError(
      `${source.relativeFile}: field "${path}" must be a union of string literals only, found "${member.getText()}"`,
    );
  });
  return { type: "enum", values };
}

const snakeColumn = (name: string) => name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

/** Entity tables, junction tables and join tables must have distinct names within a schema. */
function assertUniqueTableNames(models: EntityModel[], links: EntityModel[], sources: EntitySource[]): void {
  const owners = new Map<string, string>();
  const claim = (schema: string | null, table: string, source: string) => {
    const key = `${schema ?? ""}\u0000${table}`;
    const previous = owners.get(key);
    if (previous) throw new EntityParseError(`${previous} and ${source} both use the table name "${table}"`);
    owners.set(key, source);
  };
  models.forEach((model, index) => claim(model.schema, model.tableName, `${sources[index]!.relativeFile} (entity ${model.entityName})`));
  models.forEach((model, index) => {
    for (const field of model.fields) {
      if (field.type !== "refArray" || field.storage !== "relation") continue;
      claim(model.schema, field.joinTable ?? `${model.tableName}__${snakeColumn(field.name)}`, `${sources[index]!.relativeFile} (field "${field.name}")`);
    }
  });
  for (const link of links) {
    claim(link.schema, link.tableName, `entities/${link.link!.left.entity}.ts (field "${link.link!.left.field}")`);
  }
}

function assertUniqueCollectionNames(models: EntityModel[], sources: EntitySource[]): void {
  const fileOf = (index: number) => sources[index]!.relativeFile;
  const collections = new Map<string, string>();
  const typeNames = new Map<string, string>();
  models.forEach((model, index) => {
    const scope = model.schema ?? "";
    const collectionKey = `${scope}\u0000${model.name}`;
    const previousCollection = collections.get(collectionKey);
    if (previousCollection) {
      throw new EntityParseError(`${previousCollection} and ${fileOf(index)} both use the collection name "${model.name}"`);
    }
    collections.set(collectionKey, fileOf(index));
    const typeKey = `${scope}\u0000${model.entityName}`;
    const previousType = typeNames.get(typeKey);
    if (previousType) {
      throw new EntityParseError(`${previousType} and ${fileOf(index)} both define ${model.entityName} in the same schema`);
    }
    typeNames.set(typeKey, fileOf(index));
  });
  models.forEach((model, index) => {
    if (model.schema !== null) return;
    const clash = models.findIndex((other) => other.schema === model.name);
    if (clash >= 0) {
      throw new EntityParseError(
        `${fileOf(index)} and ${fileOf(clash)} collide: collection "${model.name}" has the same name as schema "${model.name}"`,
      );
    }
  });
}
