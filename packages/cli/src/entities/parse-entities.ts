import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  SYSTEM_FIELDS,
  type EntityModel,
  type FieldModel,
  type NestedFieldModel,
  type OnDeleteAction,
  type TypeDescriptor,
} from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import { findTag } from "./jsdoc.ts";
import { deriveCollectionName, isValidCollectionName, toCamelCase, toSnakeCase } from "./naming.ts";

const ENTITY_FILE = /^[A-Z][A-Za-z0-9]*\.ts$/;
const ON_DELETE_ACTIONS: readonly OnDeleteAction[] = ["restrict", "cascade", "setNull"];

interface EntitySource {
  file: string;
  relativeFile: string;
  key: string;
  entityName: string;
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
  let entries: string[];
  try {
    entries = readdirSync(entitiesDir).filter((entry) => entry.endsWith(".ts")).sort();
  } catch {
    return [];
  }
  return entries.map((entry) => {
    const file = resolve(entitiesDir, entry);
    const relativeFile = relative(projectRoot, file);
    if (!ENTITY_FILE.test(entry)) {
      throw new EntityParseError(`${relativeFile}: entity file names must be PascalCase (e.g. User.ts)`);
    }
    const entityName = entry.slice(0, -3);
    return { file, relativeFile, key: entityName, entityName };
  });
}

function parseEntity(program: ts.Program, context: ParseContext): EntityModel {
  const { source } = context;
  const sourceFile = program.getSourceFile(source.file);
  if (!sourceFile) throw new EntityParseError(`${source.relativeFile}: file could not be read`);

  const declaration = findEntityDeclaration(sourceFile, source);
  const name = resolveCollectionName(declaration, source);
  return {
    key: source.key,
    entityName: source.entityName,
    name,
    repoKey: toCamelCase(name),
    tableName: toSnakeCase(name),
    fields: parseFields(declarationMembers(declaration, source), context),
  };
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
  return { name, ...descriptor, optional };
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
  const seen = new Map<string, string>();
  models.forEach((model, index) => {
    const file = sources[index]!.relativeFile;
    const previous = seen.get(model.name);
    if (previous) {
      throw new EntityParseError(`${previous} and ${file} both use the collection name "${model.name}"`);
    }
    seen.set(model.name, file);
  });
}
