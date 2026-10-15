import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  hiddenPathsFor,
  parseFieldPaths,
  SYSTEM_FIELDS,
  type EntityModel,
  type Exposure,
  type ReadOperation,
  type FieldModel,
  type NestedFieldModel,
  type OnDeleteAction,
  type TypeDescriptor,
} from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import { applyEntityTags, type EntityTagTarget } from "./entity-tags.ts";
import { applyFieldTags } from "./field-tags.ts";
import { findTag, readTags } from "./jsdoc.ts";
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
}

type EntityDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

interface ParseContext {
  checker: ts.TypeChecker;
  source: EntitySource;
  sourcesByFile: Map<string, EntitySource>;
}

export function parseEntities(projectRoot: string): EntityModel[] {
  const entitiesDir = join(projectRoot, "entities");
  const sources = listEntitySources(projectRoot, entitiesDir);
  const program = ts.createProgram(
    sources.map((source) => source.file),
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
  const sourcesByFile = new Map(sources.map((source) => [source.file, source]));

  const models = sources.map((source) => parseEntity(program, { checker, source, sourcesByFile }));
  assertUniqueCollectionNames(models, sources);
  return models;
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
      if (!ENTITY_FILE.test(entry)) {
        throw new EntityParseError(`${relativeFile}: entity file names must be PascalCase (e.g. User.ts)`);
      }
      const entityName = entry.slice(0, -3);
      sources.push({ file, relativeFile, key: folder ? `${folder}/${entityName}` : entityName, entityName, folder });
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
  const name = resolveCollectionName(declaration, source);
  const schema = resolveSchema(declaration, source);
  const tagTarget: EntityTagTarget = { hooks: [], overrideHooks: "inherit", internal: false };
  applyEntityTags(tagTarget, readTags(declaration), { relativeFile: source.relativeFile });
  const { fieldSelections = [], ...tags } = tagTarget;
  const model: EntityModel = {
    key: source.key,
    entityName: source.entityName,
    schema,
    ...(schema ? { schemaKey: toCamelCase(schema) } : {}),
    name,
    repoKey: toCamelCase(name),
    tableName: toSnakeCase(name),
    fields: parseFields(declarationMembers(declaration, source), context),
    ...tags,
    exposure: { list: { include: [], exclude: [] }, read: { include: [], exclude: [] } },
  };
  model.exposure = {
    list: exposureFor(model, "list", fieldSelections, source),
    read: exposureFor(model, "read", fieldSelections, source),
  };
  return model;
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

function declarationMembers(declaration: EntityDeclaration, source: EntitySource): ts.NodeArray<ts.TypeElement> {
  if (ts.isInterfaceDeclaration(declaration)) return declaration.members;
  if (ts.isTypeLiteralNode(declaration.type)) return declaration.type.members;
  throw new EntityParseError(`${source.relativeFile}: type ${source.entityName} must be an object literal type`);
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

function parseFields(members: ts.NodeArray<ts.TypeElement>, context: ParseContext): FieldModel[] {
  const { source } = context;
  return members.map((member) => {
    const field = parseMember(member, "", true, context);
    if ((SYSTEM_FIELDS as readonly string[]).includes(field.name)) {
      throw new EntityParseError(
        `${source.relativeFile}: field "${field.name}" is a system field added to every entity and cannot be declared`,
      );
    }
    const storage = field.type === "array" || field.type === "object" ? "json" : "column";
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
  const field: NestedFieldModel = { name, ...descriptor, optional };
  applyFieldTags(field, readTags(member), { relativeFile: source.relativeFile, path, topLevel });
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
    return { type: "array", items: mapType(typeNode.elementType, path, false, context) };
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return { type: "object", fields: typeNode.members.map((member) => parseMember(member, `${path}.`, false, context)) };
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    const args = typeNode.typeArguments ?? [];
    if (name === "Date" && args.length === 0) return { type: "date" };
    if (name === "Array" && args.length === 1) return { type: "array", items: mapType(args[0]!, path, false, context) };
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

function resolveEntityReference(typeNode: ts.TypeReferenceNode, context: ParseContext): EntitySource | undefined {
  if (typeNode.typeArguments?.length) return undefined;
  let symbol = context.checker.getSymbolAtLocation(typeNode.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !(ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) return undefined;
  const target = context.sourcesByFile.get(resolve(declaration.getSourceFile().fileName));
  if (!target || declaration.name.text !== target.entityName || !isExported(declaration)) return undefined;
  return target;
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
