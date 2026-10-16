import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const project = (organization: string, user: string) => ({
  "entities/Organization.ts": `import type { User } from "./User";\nexport type Organization = { name: string; ${organization} }`,
  "entities/User.ts": `import type { Organization } from "./Organization";\nexport type User = { name: string; ${user} }`,
});
const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const fieldOf = (files: Record<string, string>, entity: string, field: string) =>
  parse(files).find((model) => model.entityName === entity)!.fields.find((candidate) => candidate.name === field)!;
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

test("a lone reference is not a relation", () => {
  expect(fieldOf(project("", "organization?: Organization"), "User", "organization").relation).toBeUndefined();
});

describe("automatic pairing", () => {
  test("N-N", () => {
    const files = project("users: User[]", "organizations: Organization[]");
    expect(fieldOf(files, "User", "organizations").relation).toEqual({
      kind: "N-N",
      inverseEntity: "Organization",
      inverseField: "users",
      storing: false,
    });
    expect(fieldOf(files, "Organization", "users").relation).toMatchObject({ kind: "N-N", inverseField: "organizations", storing: true });
  });
  test("1-N is stored on the single side", () => {
    const files = project("users: User[]", "organization: Organization");
    expect(fieldOf(files, "User", "organization").relation).toMatchObject({ kind: "1-N", storing: true });
    expect(fieldOf(files, "Organization", "users").relation).toMatchObject({ kind: "1-N", storing: false });
  });
  test("1-1 is stored alphabetically unless @owner says otherwise", () => {
    const plain = project("user?: User", "organization?: Organization");
    expect(fieldOf(plain, "Organization", "user").relation).toMatchObject({ kind: "1-1", storing: true });
    expect(fieldOf(plain, "User", "organization").relation).toMatchObject({ storing: false });
    const owned = project("user?: User", "/** @owner */ organization?: Organization");
    expect(fieldOf(owned, "User", "organization").relation).toMatchObject({ storing: true });
    expect(fieldOf(owned, "Organization", "user").relation).toMatchObject({ storing: false });
  });
});

describe("@inverse", () => {
  test("resolves ambiguity", () => {
    const ambiguous = project("users: User[]", "organization: Organization; billingOrganization?: Organization");
    const message = failure(ambiguous);
    expect(message).toContain("User.organization");
    expect(message).toContain("User.billingOrganization");
    expect(message).toContain("Organization.users");
    expect(message).toContain("@inverse");
    const resolved = project("/** @inverse organization */ users: User[]", "organization: Organization; billingOrganization?: Organization");
    expect(fieldOf(resolved, "Organization", "users").relation).toMatchObject({ inverseField: "organization" });
    expect(fieldOf(resolved, "User", "billingOrganization").relation).toBeUndefined();
  });
  test("none keeps both fields independent", () => {
    const files = project("/** @inverse none */ users: User[]", "organizations: Organization[]");
    expect(fieldOf(files, "Organization", "users").relation).toBeUndefined();
    expect(fieldOf(files, "User", "organizations").relation).toBeUndefined();
  });
  test("both sides must name each other", () => {
    const files = project("/** @inverse organizations */ users: User[]", "/** @inverse other */ organizations: Organization[]; other?: Organization[]");
    const message = failure(files);
    expect(message).toContain("Organization.users");
    expect(message).toContain("User.organizations");
  });
  test("must name a field pointing back", () => {
    expect(failure(project("/** @inverse name */ users: User[]", "organizations: Organization[]"))).toContain("@inverse name");
  });
});

test("both sides tagged @owner fail", () => {
  expect(failure(project("/** @owner */ user?: User", "/** @owner */ organization?: Organization"))).toContain("@owner");
});

test("@owner outside a 1-1 relation fails", () => {
  expect(failure(project("users: User[]", "/** @owner */ organization: Organization"))).toContain("@owner");
});

describe("self-relations", () => {
  const files = (reports: string) => ({
    "entities/User.ts": `export type User = { manager?: User; ${reports} }`,
  });
  test("pair only through @inverse", () => {
    const user = parseEntities(createProject(files("/** @inverse manager */ reports: User[]")))[0]!;
    expect(user.fields[0]!.relation).toMatchObject({ kind: "1-N", inverseField: "reports", storing: true });
    expect(user.fields[1]!.relation).toMatchObject({ kind: "1-N", inverseField: "manager", storing: false });
    const unpaired = parseEntities(createProject(files("reports: User[]")))[0]!;
    expect(unpaired.fields.every((field) => field.relation === undefined)).toBe(true);
  });
  test("a field cannot be its own inverse", () => {
    expect(failure({ "entities/User.ts": "export type User = { /** @inverse friends */ friends: User[] }" })).toContain("own @inverse");
  });
});

test("each side keeps its own @onDelete", () => {
  const files = project("/** @onDelete restrict */ users: User[]", "/** @onDelete cascade */ organizations: Organization[]");
  expect(fieldOf(files, "Organization", "users")).toMatchObject({ onDelete: "restrict" });
  expect(fieldOf(files, "User", "organizations")).toMatchObject({ onDelete: "cascade" });
});
