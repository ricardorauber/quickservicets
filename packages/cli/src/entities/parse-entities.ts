import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { SYSTEM_FIELDS, type EntityModel, type FieldModel, type PrimitiveFieldType } from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import { deriveCollectionName, isValidCollectionName, toCamelCase, toSnakeCase } from "./naming.ts";

const ENTITY_FILE = /^[A-Z][A-Za-z0-9]*\.ts$/;

interface EntitySource {
  file: string;
  relativeFile: string;
  entityName: string;
}

export function parseEntities(projectRoot: string): EntityModel[] {
  const entitiesDir = join(projectRoot, "entities");
  const sources = listEntitySources(projectRoot, entitiesDir);
  const program = ts.createProgram(
    sources.map((source) => source.file),
    { strict: true, noEmit: true, noLib: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ESNext },
  );
  // Creating the checker binds every source file, which sets the parent pointers the parser relies on.
  program.getTypeChecker();

  const models = sources.map((source) => parseEntity(program, source));
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
    const file = join(entitiesDir, entry);
    const relativeFile = relative(projectRoot, file);
    if (!ENTITY_FILE.test(entry)) {
      throw new EntityParseError(`${relativeFile}: entity file names must be PascalCase (e.g. User.ts)`);
    }
    return { file, relativeFile, entityName: entry.slice(0, -3) };
  });
}

function parseEntity(program: ts.Program, source: EntitySource): EntityModel {
  const sourceFile = program.getSourceFile(source.file);
  if (!sourceFile) throw new EntityParseError(`${source.relativeFile}: file could not be read`);

  const declaration = findEntityDeclaration(sourceFile, source);
  const name = resolveCollectionName(declaration, source);
  return {
    entityName: source.entityName,
    name,
    repoKey: toCamelCase(name),
    tableName: toSnakeCase(name),
    fields: parseFields(declarationMembers(declaration, source), source),
  };
}

type EntityDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function findEntityDeclaration(sourceFile: ts.SourceFile, source: EntitySource): EntityDeclaration {
  const exportedTypes = sourceFile.statements.filter(
    (statement): statement is EntityDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && isExported(statement),
  );
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

function jsDocTags(node: ts.Node): readonly ts.JSDocTag[] {
  return ts.getJSDocTags(node);
}

function tagText(tag: ts.JSDocTag): string {
  return (ts.getTextOfJSDocComment(tag.comment) ?? "").trim();
}

function resolveCollectionName(declaration: EntityDeclaration, source: EntitySource): string {
  const tag = jsDocTags(declaration).find((candidate) => candidate.tagName.text === "collection");
  if (!tag) return deriveCollectionName(source.entityName);
  const name = tagText(tag);
  if (!isValidCollectionName(name)) {
    throw new EntityParseError(
      `${source.relativeFile}: @collection "${name}" must match ^[a-z][a-z0-9-]*$`,
    );
  }
  return name;
}

function parseFields(members: ts.NodeArray<ts.TypeElement>, source: EntitySource): FieldModel[] {
  return members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type) {
      throw new EntityParseError(`${source.relativeFile}: only typed properties are supported in ${source.entityName}`);
    }
    const name = member.name.getText();
    if ((SYSTEM_FIELDS as readonly string[]).includes(name)) {
      throw new EntityParseError(
        `${source.relativeFile}: field "${name}" is a system field added to every entity and cannot be declared`,
      );
    }
    return { name, type: mapPrimitiveType(member.type, name, source), optional: member.questionToken !== undefined };
  });
}

function mapPrimitiveType(typeNode: ts.TypeNode, fieldName: string, source: EntitySource): PrimitiveFieldType {
  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return "string";
    case ts.SyntaxKind.NumberKeyword:
      return "number";
    case ts.SyntaxKind.BooleanKeyword:
      return "boolean";
  }
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText() === "Date" && !typeNode.typeArguments) {
    return "date";
  }
  throw new EntityParseError(
    `${source.relativeFile}: field "${fieldName}" has unsupported type "${typeNode.getText()}"`,
  );
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
