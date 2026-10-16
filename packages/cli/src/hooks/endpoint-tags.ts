import type { HookCall } from "@quickservice/core";
import ts from "typescript";
import { splitArgs } from "../entities/entity-tags.ts";
import { readTags, type DocTag } from "../entities/jsdoc.ts";
import { BuildError } from "../errors.ts";
import { tagDocRegistry } from "../tag-docs.ts";

/** What an endpoint's JSDoc declares besides hooks; built-in endpoint tags fill it in. */
export interface EndpointMetadata {
  /** Response projection from `@fields` (include) or `@exclude`. */
  projection?: { include?: string[]; exclude?: string[] };
  /** Reference paths from `@populate`. */
  populate?: string[];
  /** `@summary`: one line shown as the operation summary in the API docs. */
  summary?: string;
  /** `@description`: free text shown as the operation description in the API docs. */
  description?: string;
}

type EndpointTagHandler = (tag: DocTag, file: string, metadata: EndpointMetadata) => void;

const builtInEndpointTags = new Map<string, EndpointTagHandler>();

/** Registers a built-in endpoint JSDoc tag. Every other endpoint tag is read as a hook reference. */
export function registerEndpointTag(name: string, handler: EndpointTagHandler = () => {}): void {
  builtInEndpointTags.set(name, handler);
}

const endpointTagDocs = tagDocRegistry(() => builtInEndpointTags.keys());
/** Documents an endpoint tag for the reference pages. */
export const describeEndpointTag = endpointTagDocs.describe;
/** Every built-in endpoint tag with its documentation. */
export const documentedEndpointTags = endpointTagDocs.list;

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

export interface EndpointTags {
  hooks: HookCall[];
  metadata: EndpointMetadata;
}

/** Reads the hook references and built-in tags written as JSDoc on an endpoint's default export. */
export function parseEndpointTags(source: string, file: string): EndpointTags {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const node = defaultExportNode(sourceFile);
  if (!node) throw new BuildError(`${file}: endpoints must have a default export`);
  const hooks: HookCall[] = [];
  const metadata: EndpointMetadata = {};
  for (const tag of readTags(node)) {
    const handler = builtInEndpointTags.get(tag.name);
    if (handler) {
      handler(tag, file, metadata);
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
  return { hooks, metadata };
}

/** Reads the hook references written as JSDoc tags on an endpoint's default export. */
export function parseEndpointHooks(source: string, file: string): HookCall[] {
  return parseEndpointTags(source, file).hooks;
}

function projectionTag(kind: "include" | "exclude"): EndpointTagHandler {
  return (tag, file, metadata) => {
    if (metadata.projection) throw new BuildError(`${file}: use either @fields or @exclude, not both`);
    const paths = splitArgs(tag.text);
    if (paths.length === 0) throw new BuildError(`${file}: @${tag.name} needs at least one path`);
    metadata.projection = { [kind]: paths };
  };
}

registerEndpointTag("populate", (tag, file, metadata) => {
  const paths = splitArgs(tag.text);
  if (paths.length === 0) throw new BuildError(`${file}: @populate needs at least one path`);
  metadata.populate = [...new Set([...(metadata.populate ?? []), ...paths])];
});
registerEndpointTag("summary", (tag, file, metadata) => {
  const [line = ""] = tag.text.split("\n");
  if (line.trim() === "") throw new BuildError(`${file}: @summary needs a text`);
  metadata.summary = line.trim();
});
registerEndpointTag("description", (tag, file, metadata) => {
  if (tag.text === "") throw new BuildError(`${file}: @description needs a text`);
  metadata.description = tag.text;
});
registerEndpointTag("fields", projectionTag("include"));
registerEndpointTag("exclude", projectionTag("exclude"));

describeEndpointTag("summary", {
  description: "One-line summary of the operation in the API docs.",
  appliesTo: "Custom endpoints",
  example: "/** @summary Organization stats */",
});
describeEndpointTag("description", {
  description: "Longer text of the operation in the API docs; may span several lines.",
  appliesTo: "Custom endpoints",
  example: "/** @description Counts the members of an organization. */",
});
describeEndpointTag("fields", {
  description: "Fields the response keeps.",
  appliesTo: "Custom endpoints",
  example: "/** @fields id,name */",
});
describeEndpointTag("exclude", {
  description: "Fields removed from the response.",
  appliesTo: "Custom endpoints",
  example: "/** @exclude secret */",
});
describeEndpointTag("populate", {
  description: "Reference paths populated on the response of an override of a list or read route.",
  appliesTo: "Overrides of generated list and read routes",
  example: "/** @populate organization */",
});
