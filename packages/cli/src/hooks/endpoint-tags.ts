import type { HookCall } from "@quickservice/core";
import ts from "typescript";
import { splitArgs } from "../entities/entity-tags.ts";
import { readTags, type DocTag } from "../entities/jsdoc.ts";
import { BuildError } from "../errors.ts";

type EndpointTagHandler = (tag: DocTag, file: string) => void;

const builtInEndpointTags = new Map<string, EndpointTagHandler>();

/** Registers a built-in endpoint JSDoc tag. Every other endpoint tag is read as a hook reference. */
export function registerEndpointTag(name: string, handler: EndpointTagHandler = () => {}): void {
  builtInEndpointTags.set(name, handler);
}

export function isBuiltInEndpointTag(name: string): boolean {
  return builtInEndpointTags.has(name);
}

function defaultExportNode(sourceFile: ts.SourceFile): ts.Node | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression) && readTags(statement).length === 0) {
        const name = statement.expression.text;
        const declaration = sourceFile.statements.find(
          (candidate) =>
            ts.isVariableStatement(candidate) &&
            candidate.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name),
        );
        if (declaration) return declaration;
      }
      return statement;
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement;
    }
  }
  return undefined;
}

/** Reads the hook references written as JSDoc tags on an endpoint's default export. */
export function parseEndpointHooks(source: string, file: string): HookCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const node = defaultExportNode(sourceFile);
  if (!node) throw new BuildError(`${file}: endpoints must have a default export`);
  const hooks: HookCall[] = [];
  for (const tag of readTags(node)) {
    const handler = builtInEndpointTags.get(tag.name);
    if (handler) {
      handler(tag, file);
      continue;
    }
    if (tag.text.startsWith(":")) {
      throw new BuildError(`${file}: @${tag.name} cannot have an operation scope on an endpoint`);
    }
    if (hooks.some((hook) => hook.name === tag.name)) {
      throw new BuildError(`${file}: hook @${tag.name} is declared more than once`);
    }
    hooks.push({ name: tag.name, args: splitArgs(tag.text) });
  }
  return hooks;
}
