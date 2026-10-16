import { join, relative, resolve, sep } from "node:path";
import type { CrudOperation, EntityModel, HookCall } from "@quickservice/core";
import ts from "typescript";
import type { EndpointRoute } from "../endpoints/scan-endpoints.ts";
import type { EndpointMetadata } from "../hooks/endpoint-tags.ts";
import { componentNames, type JsonSchema } from "./generate-openapi.ts";

/** What the OpenAPI document needs to know about one custom endpoint. */
export interface EndpointDoc {
  method: string;
  /** Route path with dynamic segments in brackets, e.g. `/organizations/[orgId]`. */
  path: string;
  params: string[];
  file: string;
  summary?: string;
  description?: string;
  /** Whether the default export is typed as `Endpoint<...>` with type arguments. */
  hasGenerics: boolean;
  body?: JsonSchema;
  result?: JsonSchema;
  /** The generated CRUD route the endpoint replaces. */
  override?: { entity: string; operation: CrudOperation };
  /** Resolved hooks in execution order, as the runtime runs them. */
  hooks: HookCall[];
  /** `@fields`/`@exclude` of the endpoint. */
  projection?: { include?: string[]; exclude?: string[] };
}

export interface EndpointDocInput {
  route: EndpointRoute;
  metadata: EndpointMetadata;
  override?: { entity: string; operation: CrudOperation };
  hooks?: HookCall[];
}

class UnsupportedType extends Error {}

const unsupported = (node: ts.Node): never => {
  throw new UnsupportedType(node.getText());
};

/** The `Endpoint<Body, Result>` type node the default export is declared with, if any. */
function endpointTypeOf(sourceFile: ts.SourceFile): ts.TypeReferenceNode | undefined {
  const isEndpointType = (node: ts.TypeNode | undefined): node is ts.TypeReferenceNode =>
    node !== undefined &&
    ts.isTypeReferenceNode(node) &&
    (ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text) === "Endpoint";
  const fromExpression = (expression: ts.Expression): ts.TypeReferenceNode | undefined => {
    if ((ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) && isEndpointType(expression.type)) return expression.type;
    if (ts.isParenthesizedExpression(expression)) return fromExpression(expression.expression);
    return undefined;
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    if (ts.isIdentifier(statement.expression)) {
      const name = statement.expression.text;
      for (const candidate of sourceFile.statements) {
        if (!ts.isVariableStatement(candidate)) continue;
        for (const declaration of candidate.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
          if (isEndpointType(declaration.type)) return declaration.type;
          if (declaration.initializer) return fromExpression(declaration.initializer);
        }
      }
      return undefined;
    }
    return fromExpression(statement.expression);
  }
  return undefined;
}

const isAbsent = (node: ts.TypeNode | undefined) =>
  node === undefined ||
  node.kind === ts.SyntaxKind.UnknownKeyword ||
  node.kind === ts.SyntaxKind.VoidKeyword ||
  node.kind === ts.SyntaxKind.UndefinedKeyword ||
  node.kind === ts.SyntaxKind.NeverKeyword;

interface ConvertContext {
  checker: ts.TypeChecker;
  entitiesDir: string;
  models: EntityModel[];
  names: Map<string, string>;
  /** Declarations being converted, to stop on recursive types. */
  visiting: Set<ts.Declaration>;
}

function declarationOf(name: ts.EntityName, checker: ts.TypeChecker): { declaration?: ts.Declaration; module?: string } {
  let symbol = checker.getSymbolAtLocation(name);
  let module: string | undefined;
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    const specifier = symbol.declarations?.[0];
    const importDeclaration = specifier && ts.findAncestor(specifier, ts.isImportDeclaration);
    if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) module = importDeclaration.moduleSpecifier.text;
    symbol = checker.getAliasedSymbol(symbol);
  }
  return { declaration: symbol?.declarations?.[0], module };
}

/** The entity a type reference names: a declaration in `/entities`, or `File`/`Media` from the core package. */
function entityOf(name: string, found: { declaration?: ts.Declaration; module?: string }, context: ConvertContext): EntityModel | undefined {
  if (found.module === "@quickservice/core") {
    return context.models.find((model) => model.key === name && model.file);
  }
  const file = found.declaration?.getSourceFile().fileName;
  if (!file || !resolve(file).startsWith(`${context.entitiesDir}${sep}`)) return undefined;
  const key = relative(context.entitiesDir, resolve(file)).replace(/\.ts$/, "").split(sep).join("/");
  return context.models.find((model) => model.key === key && model.entityName === name);
}

function nullable(schema: JsonSchema): JsonSchema {
  if (typeof schema.$ref === "string") return { anyOf: [schema, { type: "null" }] };
  const result: JsonSchema = { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.enum)) result.enum = [...(schema.enum as unknown[]), null];
  return result;
}

function membersSchema(members: readonly ts.TypeElement[], context: ConvertContext): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) return unsupported(member);
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : unsupported(member.name);
    properties[name] = typeSchema(member.type, context);
    if (!member.questionToken) required.push(name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

function referenceSchema(node: ts.TypeReferenceNode, context: ConvertContext): JsonSchema {
  const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
  if (name === "Date" && !node.typeArguments) return { type: "string", format: "date-time" };
  if (name === "Array" && node.typeArguments?.length === 1) return { type: "array", items: typeSchema(node.typeArguments[0]!, context) };
  const found = declarationOf(node.typeName, context.checker);
  const entity = entityOf(name, found, context);
  if (entity && !node.typeArguments) return { $ref: `#/components/schemas/${context.names.get(entity.key)}` };
  const declaration = found.declaration;
  if (!declaration || node.typeArguments || context.visiting.has(declaration)) return unsupported(node);
  context.visiting.add(declaration);
  try {
    if (ts.isTypeAliasDeclaration(declaration) && !declaration.typeParameters) return typeSchema(declaration.type, context);
    if (ts.isInterfaceDeclaration(declaration) && !declaration.typeParameters && !declaration.heritageClauses) {
      return membersSchema(declaration.members, context);
    }
    return unsupported(node);
  } finally {
    context.visiting.delete(declaration);
  }
}

function unionSchema(node: ts.UnionTypeNode, context: ConvertContext): JsonSchema {
  const isNull = (type: ts.TypeNode) =>
    type.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword);
  const types = node.types.filter((type) => !isNull(type));
  const hasNull = types.length < node.types.length;
  let schema: JsonSchema;
  if (types.length > 0 && types.every((type) => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))) {
    schema = { type: "string", enum: types.map((type) => ((type as ts.LiteralTypeNode).literal as ts.StringLiteral).text) };
  } else if (types.length === 1) {
    schema = typeSchema(types[0]!, context);
  } else {
    return unsupported(node);
  }
  return hasNull ? nullable(schema) : schema;
}

/** Converts a type node into a JSON schema, throwing `UnsupportedType` for types entities cannot use. */
function typeSchema(node: ts.TypeNode, context: ConvertContext): JsonSchema {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
  }
  if (ts.isParenthesizedTypeNode(node)) return typeSchema(node.type, context);
  if (ts.isArrayTypeNode(node)) return { type: "array", items: typeSchema(node.elementType, context) };
  if (ts.isTypeLiteralNode(node)) return membersSchema(node.members, context);
  if (ts.isUnionTypeNode(node)) return unionSchema(node, context);
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return { type: "string", enum: [node.literal.text] };
  if (ts.isTypeReferenceNode(node)) return referenceSchema(node, context);
  return unsupported(node);
}

/**
 * Reads the OpenAPI details of custom endpoints: `@summary`/`@description` and the `Body`/`Result` type arguments of
 * `Endpoint<Body, Result>`. Types that cannot be converted become `{ type: "object" }` with a warning.
 */
export function describeEndpoints(
  projectRoot: string,
  models: EntityModel[],
  endpoints: EndpointDocInput[],
): { docs: EndpointDoc[]; warnings: string[] } {
  const files = endpoints.map((endpoint) => join(projectRoot, endpoint.route.file));
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const warnings: string[] = [];
  const context: ConvertContext = {
    checker,
    entitiesDir: resolve(projectRoot, "entities"),
    models,
    names: componentNames(models.filter((model) => !model.link)),
    visiting: new Set(),
  };
  const docs = endpoints.map(({ route, metadata, override, hooks = [] }, index): EndpointDoc => {
    const sourceFile = program.getSourceFile(files[index]!);
    const endpointType = sourceFile ? endpointTypeOf(sourceFile) : undefined;
    const [bodyNode, resultNode] = endpointType?.typeArguments ?? [];
    const convert = (node: ts.TypeNode | undefined): JsonSchema | undefined => {
      if (isAbsent(node)) return undefined;
      try {
        return typeSchema(node!, context);
      } catch (error) {
        if (!(error instanceof UnsupportedType)) throw error;
        warnings.push(`${route.file}: cannot document type ${error.message}; using object`);
        return { type: "object" };
      }
    };
    return {
      method: route.method,
      path: route.path,
      params: route.params,
      file: route.file,
      ...(metadata.summary ? { summary: metadata.summary } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      hasGenerics: (endpointType?.typeArguments?.length ?? 0) > 0,
      ...withValue("body", convert(bodyNode)),
      ...withValue("result", convert(resultNode)),
      ...(override ? { override } : {}),
      ...(metadata.projection ? { projection: metadata.projection } : {}),
      hooks,
    };
  });
  return { docs, warnings };
}

const withValue = <K extends string>(key: K, value: JsonSchema | undefined) => (value ? { [key]: value } : {}) as Partial<Record<K, JsonSchema>>;
