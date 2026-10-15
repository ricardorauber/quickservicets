import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const system = ["id", "createdAt", "updatedAt"];
const userWith = (doc: string, body: string) =>
  parseEntities(createProject({ "entities/User.ts": `${doc ? `/** ${doc} */\n` : ""}export type User = {\n${body}\n}` }))[0]!;
const failure = (doc: string, body: string) => {
  try {
    userWith(doc, body);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};
const fields = "name: string;\nemail: string;\naddress: { city: string; zip: string };";

describe("@hidden", () => {
  test("scoped to list keeps the field on read", () => {
    const user = userWith("", "name: string;\n/** @hidden:list */ address: { city: string };");
    expect(user.fields[1]).toMatchObject({ hiddenOn: ["list"] });
    expect(user.exposure.list.exclude).toEqual(["address"]);
    expect(user.exposure.read.exclude).toEqual([]);
  });
  test("scoped to both operations", () => {
    expect(userWith("", "/** @hidden:list,read */ name: string;").exposure.read.exclude).toEqual(["name"]);
  });
  test("unscoped on nested properties is never exposed", () => {
    const user = userWith("", "address: { /** @hidden */ zip: string; city: string };");
    expect(user.exposure.list.exclude).toEqual(["address.zip"]);
    expect(user.exposure.read.exclude).toEqual(["address.zip"]);
  });
  test("scoped on nested properties", () => {
    expect(userWith("", "address: { /** @hidden:read */ zip: string; city: string };").exposure.read.exclude).toEqual(["address.zip"]);
  });
});

describe("@fields", () => {
  test("scoped to list", () => {
    const user = userWith("@fields:list id,name,email", fields);
    expect(user.exposure.list).toEqual({ include: ["id", "name", "email"], exclude: [] });
    expect(user.exposure.read.include).toEqual([...system, "name", "email", "address"]);
  });
  test("unscoped applies to list and read", () => {
    const user = userWith("@fields name,address.city", fields);
    expect(user.exposure.list.include).toEqual(["name", "address.city"]);
    expect(user.exposure.read.include).toEqual(["name", "address.city"]);
  });
  test("id may be left out", () => {
    expect(userWith("@fields:list name,email", fields).exposure.list.include).not.toContain("id");
  });
});

test("exposure combines the whitelist with hidden paths", () => {
  const user = userWith("@fields:read name,address", "name: string;\naddress: { city: string; /** @hidden:read */ zip: string };");
  expect(user.exposure.read).toEqual({ include: ["name", "address"], exclude: ["address.zip"] });
});

describe("conflicts and invalid tags", () => {
  test("a whitelisted path hidden for the same operation names entity, path and operation", () => {
    const message = failure("@fields:list id,address", "/** @hidden:list */ address: { city: string };");
    expect(message).toContain("User");
    expect(message).toContain('"address"');
    expect(message).toContain("list");
  });
  test("a whitelisted path inside an always-hidden one", () => {
    expect(failure("@fields address.city", "/** @hidden */ address: { city: string };")).toContain("address.city");
  });
  test.each([
    ["", "/** @hidden:create */ name: string;", "@hidden"],
    ["@fields:delete id", "name: string;", "@fields"],
    ["@fields:list nope", "name: string;", "nope"],
    ["@fields:list name @fields:list,read id", "name: string;", "@fields"],
  ])("%s %s fails", (doc, body, expected) => {
    const message = failure(doc, body);
    expect(message).toContain("entities/User.ts");
    expect(message).toContain(expected);
  });
});
