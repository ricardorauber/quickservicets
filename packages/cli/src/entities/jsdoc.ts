import ts from "typescript";

export interface DocTag {
  name: string;
  text: string;
}

const INLINE_TAG = /@([A-Za-z_$][\w$]*)([^@]*)/g;

function parseDocComment(comment: string): DocTag[] {
  const body = comment
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
  return [...body.matchAll(INLINE_TAG)].map(([, name, text]) => ({ name: name!, text: (text ?? "").trim() }));
}

/**
 * Reads the JSDoc tags attached to a node. TypeScript does not attach a JSDoc comment written on the same
 * line as an opening brace (e.g. `{ /** @tag *\/ field: T }`), so leading comments are parsed as a fallback.
 */
export function readTags(node: ts.Node): DocTag[] {
  const tags = ts.getJSDocTags(node);
  if (tags.length > 0) {
    return tags.map((tag) => ({ name: tag.tagName.text, text: (ts.getTextOfJSDocComment(tag.comment) ?? "").trim() }));
  }
  const sourceFile = node.getSourceFile();
  const start = node.getFullStart();
  // A comment on the same line as the previous token is reported as a trailing comment of that token.
  const ranges = [
    ...(ts.getTrailingCommentRanges(sourceFile.text, start) ?? []),
    ...(ts.getLeadingCommentRanges(sourceFile.text, start) ?? []),
  ];
  return ranges.flatMap((range) => {
    const comment = sourceFile.text.slice(range.pos, range.end);
    return comment.startsWith("/**") ? parseDocComment(comment) : [];
  });
}

export function findTag(node: ts.Node, name: string): DocTag | undefined {
  return readTags(node).find((tag) => tag.name === name);
}
