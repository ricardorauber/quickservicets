import { expect, test } from "bun:test";
import ts from "typescript";
import { readTags } from "./jsdoc.ts";

const firstMember = (text: string) => {
  const sourceFile = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ESNext, true);
  const alias = sourceFile.statements[0] as ts.TypeAliasDeclaration;
  return (alias.type as ts.TypeLiteralNode).members[0]!;
};

test("reads tags written on their own line", () => {
  expect(readTags(firstMember("type U = {\n  /** @onDelete cascade */\n  a: O }"))).toEqual([{ name: "onDelete", text: "cascade" }]);
});

test("reads tags written on the same line as the opening brace", () => {
  expect(readTags(firstMember("type U = { /** @onDelete cascade @index */ a: O }"))).toEqual([
    { name: "onDelete", text: "cascade" },
    { name: "index", text: "" },
  ]);
});
