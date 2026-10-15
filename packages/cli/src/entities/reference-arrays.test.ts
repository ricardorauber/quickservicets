import { describe, expect, test } from "bun:test";
import { createRepositories, HttpError, memoryAdapter, type Repository } from "@quickservice/core";
import { generateTypesFile } from "../build/generate-types.ts";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const user = "export type User = { name: string }";
const organizationWith = (members: string) => ({
  "entities/User.ts": user,
  "entities/Media.ts": "export type Media = { url: string }",
  "entities/Organization.ts": `import type { User } from "./User";\nimport type { Media } from "./Media";\nexport type Organization = {\n  name: string;\n  ${members}\n}`,
});
const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const field = (files: Record<string, string>, name = "members") =>
  parse(files).find((model) => model.entityName === "Organization")!.fields.find((candidate) => candidate.name === name);
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

describe("parsing", () => {
  test("arrays of entity types become reference arrays", () => {
    expect(field(organizationWith("members: User[];"))).toEqual({
      name: "members",
      type: "refArray",
      target: "User",
      onDelete: "pull",
      optional: false,
      storage: "relation",
    });
    expect(field(organizationWith("gallery?: Array<Media>;"), "gallery")).toMatchObject({ type: "refArray", target: "Media", optional: true });
  });
  test("@onDelete accepts pull, restrict and cascade", () => {
    expect(field(organizationWith("/** @onDelete cascade */ members: User[];"))).toMatchObject({ onDelete: "cascade" });
    expect(failure(organizationWith("/** @onDelete setNull */ members?: User[];"))).toContain('"members"');
    expect(failure(organizationWith("/** @onDelete wipe */ members: User[];"))).toContain('"members"');
  });
  test("tag applicability", () => {
    expect(field(organizationWith("/** @minItems 1 @maxItems 3 @default [] */ members: User[];"))).toMatchObject({
      minLength: 1,
      maxLength: 3,
      default: [],
    });
    expect(field(organizationWith("/** @minLength 1 */ members: User[];"))).toMatchObject({ minLength: 1 });
    for (const tag of ["@unique", "@index", "@default ['x']"]) {
      expect(failure(organizationWith(`/** ${tag} */ members: User[];`))).toContain("entities/Organization.ts");
    }
  });
});

async function repositories() {
  const models = parse(organizationWith("/** @maxItems 2 */ members?: User[];"));
  const adapter = memoryAdapter();
  await adapter.connect(models);
  const repos = createRepositories(models, adapter);
  const users = repos.users as Repository;
  const organizations = repos.organizations as Repository;
  const [a, b, c] = await Promise.all(["a", "b", "c"].map((name) => users.create({ name })));
  return { organizations, a: a!.id, b: b!.id, c: c!.id };
}

const detailsOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).details;
  }
  throw new Error("expected an HttpError");
};

describe("validation and storage", () => {
  test("duplicates fail at the second occurrence", async () => {
    const { organizations, a } = await repositories();
    expect(await detailsOf(organizations.create({ name: "x", members: [a, a] }))).toEqual([{ field: "members[1]", message: "Duplicate item" }]);
  });
  test("missing records fail at their index", async () => {
    const { organizations, a } = await repositories();
    expect(await detailsOf(organizations.create({ name: "x", members: [a, Bun.randomUUIDv7()] }))).toEqual([
      { field: "members[1]", message: "Referenced record not found" },
    ]);
  });
  test("item limits", async () => {
    const { organizations, a, b, c } = await repositories();
    expect(await detailsOf(organizations.create({ name: "x", members: [a, b, c] }))).toEqual([
      { field: "members", message: "Must have at most 2 items" },
    ]);
  });
  test("non-string items fail", async () => {
    const { organizations } = await repositories();
    expect(await detailsOf(organizations.create({ name: "x", members: [""] }))).toEqual([{ field: "members[0]", message: "Must be a string" }]);
  });
  test("order is preserved", async () => {
    const { organizations, a, b } = await repositories();
    expect((await organizations.create({ name: "x", members: [b, a] })).members).toEqual([b, a]);
  });
  test("omitted or null optional arrays are stored and returned as []", async () => {
    const { organizations, a } = await repositories();
    const created = await organizations.create({ name: "x" });
    expect(created.members).toEqual([]);
    await organizations.update(created.id, { members: [a] });
    expect((await organizations.update(created.id, { members: null })).members).toEqual([]);
    expect((await organizations.replace(created.id, { name: "y" })).members).toEqual([]);
  });
});

test("generated types use string arrays", () => {
  const types = generateTypesFile(parse(organizationWith("members?: User[];")));
  expect(types).toContain("  members: Array<string>;");
});
