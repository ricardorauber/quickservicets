import { describe, expect, test } from "bun:test";
import { CRUD_OPERATIONS } from "@quickservice/core";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const entityWith = (doc: string) =>
  parseEntities(createProject({ "entities/User.ts": `/**\n${doc}\n */\nexport type User = { name: string }` }))[0]!;
const inline = (doc: string) =>
  parseEntities(createProject({ "entities/User.ts": `/** ${doc} */\nexport type User = { name: string }` }))[0]!;
const failure = (doc: string) => {
  try {
    entityWith(doc);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};
const all = [...CRUD_OPERATIONS];

test("hook tags without scope or args", () => {
  expect(inline("@authorized @sanitize").hooks).toEqual([
    { name: "authorized", operations: all, args: [] },
    { name: "sanitize", operations: all, args: [] },
  ]);
});

describe("scope and args", () => {
  test("scope only", () => {
    expect(entityWith("@authorized:create,delete").hooks).toEqual([
      { name: "authorized", operations: ["create", "delete"], args: [] },
    ]);
  });
  test("args only", () => {
    expect(entityWith("@authorized admin").hooks).toEqual([{ name: "authorized", operations: all, args: ["admin"] }]);
  });
  test("scope plus args", () => {
    expect(inline("@authorized:create,delete admin, owner").hooks).toEqual([
      { name: "authorized", operations: ["create", "delete"], args: ["admin", "owner"] },
    ]);
  });
});

test("arguments are trimmed and empty segments dropped", () => {
  expect(entityWith("@audit  a , ,b,").hooks).toEqual([{ name: "audit", operations: all, args: ["a", "b"] }]);
});

test("unknown operations are rejected naming the file and tag", () => {
  const message = failure("@authorized:remove");
  expect(message).toContain("entities/User.ts");
  expect(message).toContain("@authorized");
});

describe("@overrideHooks", () => {
  test("defaults to inherit", () => {
    expect(entityWith("@authorized").overrideHooks).toBe("inherit");
  });
  test("accepts replace", () => {
    expect(entityWith("@overrideHooks replace").overrideHooks).toBe("replace");
  });
  test("rejects other values", () => {
    expect(failure("@overrideHooks maybe")).toContain("@overrideHooks");
  });
});

describe("@internal", () => {
  test("sets the flag", () => {
    expect(entityWith("@internal").internal).toBe(true);
    expect(entityWith("@authorized").internal).toBe(false);
  });
  test("takes no value", () => {
    expect(failure("@internal yes")).toContain("@internal");
  });
});

test("duplicate hook names are rejected", () => {
  expect(failure("@authorized @authorized:read")).toContain("authorized");
});

test("built-in entity tags are not recorded as hooks", () => {
  const entity = inline("@collection people @authorized @overrideHooks replace @internal");
  expect(entity.hooks.map((hook) => hook.name)).toEqual(["authorized"]);
  expect(entity.name).toBe("people");
});
