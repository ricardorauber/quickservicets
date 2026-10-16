import { join } from "node:path";
import type { QueryItem, QueryValueType } from "@quickservice/core";
import ts from "typescript";
import { BuildError } from "../errors.ts";
import { endpointTypeOf } from "../openapi/endpoint-docs.ts";
import type { EndpointRoute } from "./scan-endpoints.ts";

const QUERY_METHODS = new Set(["GET", "DELETE"]);

function resolved(node: ts.TypeReferenceNode, checker: ts.TypeChecker): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

const stringLiterals = (union: ts.UnionTypeNode): string[] | undefined => {
  const values = union.types.map((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : undefined,
  );
  return values.every((value) => value !== undefined) ? (values as string[]) : undefined;
};

/** Values of a string enum, or the member names of an enum without initializers. */
function enumValues(declaration: ts.EnumDeclaration): string[] | undefined {
  const members = declaration.members;
  if (members.every((member) => member.initializer === undefined)) return members.map((member) => member.name.getText());
  if (!members.every((member) => member.initializer && ts.isStringLiteralLike(member.initializer))) return undefined;
  return members.map((member) => (member.initializer as ts.StringLiteralLike).text);
}

function valueType(node: ts.TypeNode, checker: ts.TypeChecker): QueryValueType | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
  }
  if (ts.isParenthesizedTypeNode(node)) return valueType(node.type, checker);
  if (ts.isUnionTypeNode(node)) {
    const values = stringLiterals(node);
    return values ? { type: "enum", values } : undefined;
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return { type: "enum", values: [node.literal.text] };
  if (!ts.isTypeReferenceNode(node) || node.typeArguments) return undefined;
  if (node.typeName.getText() === "Date") return { type: "date" };
  const declaration = resolved(node, checker);
  if (declaration && ts.isEnumDeclaration(declaration)) {
    const values = enumValues(declaration);
    return values ? { type: "enum", values } : undefined;
  }
  if (declaration && ts.isTypeAliasDeclaration(declaration) && !declaration.typeParameters) return valueType(declaration.type, checker);
  return undefined;
}

function itemOf(member: ts.TypeElement, file: string, checker: ts.TypeChecker): QueryItem {
  const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : member.getText();
  const type = ts.isPropertySignature(member) ? member.type : undefined;
  const fail = () => new BuildError(`${file}: query item "${name}" has unsupported type "${type?.getText() ?? member.getText()}"`);
  if (!type) throw fail();
  const optional = (member as ts.PropertySignature).questionToken !== undefined;
  const element = ts.isArrayTypeNode(type)
    ? type.elementType
    : ts.isTypeReferenceNode(type) && type.typeName.getText() === "Array" && type.typeArguments?.length === 1
      ? type.typeArguments[0]
      : undefined;
  if (element) {
    const items = valueType(element, checker);
    if (!items) throw fail();
    return { name, optional, type: "array", items };
  }
  const single = valueType(type, checker);
  if (!single) throw fail();
  return { name, optional, ...single };
}

function membersOf(node: ts.TypeNode, checker: ts.TypeChecker): readonly ts.TypeElement[] | undefined {
  if (ts.isParenthesizedTypeNode(node)) return membersOf(node.type, checker);
  if (ts.isTypeLiteralNode(node)) return node.members;
  if (!ts.isTypeReferenceNode(node) || node.typeArguments) return undefined;
  const declaration = resolved(node, checker);
  if (declaration && ts.isTypeAliasDeclaration(declaration) && !declaration.typeParameters) return membersOf(declaration.type, checker);
  if (declaration && ts.isInterfaceDeclaration(declaration) && !declaration.typeParameters && !declaration.heritageClauses) {
    return declaration.members;
  }
  return undefined;
}

const isAbsent = (node: ts.TypeNode | undefined) => node === undefined || node.kind === ts.SyntaxKind.UnknownKeyword;

/**
 * Reads the query items of GET and DELETE endpoints from the first type argument of `Endpoint<Query, Result>`,
 * keyed by endpoint file; endpoints without one are left out.
 */
export function extractQueryItems(projectRoot: string, routes: EndpointRoute[]): Map<string, QueryItem[]> {
  const candidates = routes.filter((route) => QUERY_METHODS.has(route.method));
  const result = new Map<string, QueryItem[]>();
  if (candidates.length === 0) return result;
  const files = candidates.map((route) => join(projectRoot, route.file));
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
  candidates.forEach((route, index) => {
    const sourceFile = program.getSourceFile(files[index]!);
    const queryNode = sourceFile ? endpointTypeOf(sourceFile)?.typeArguments?.[0] : undefined;
    if (isAbsent(queryNode)) return;
    const members = membersOf(queryNode!, checker);
    if (!members) throw new BuildError(`${route.file}: the query type must be an object type`);
    result.set(route.file, members.map((member) => itemOf(member, route.file, checker)));
  });
  return result;
}
