import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, memoryAdapter, resolveConfig, validateBody } from "@quickservice/core";
import ts from "typescript";
import { crudTable, build } from "./build.ts";
import { generateOpenApi } from "../openapi/generate-openapi.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";

const entities = {
  "entities/User.ts": "export type User = { email: string }",
  "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; members: User[]; tags: string[] }',
};
const models = parseProjectEntities(createProject(entities));
const organization = models.find((model) => model.entityName === "Organization")!;

describe("validator", () => {
  test("non-optional reference arrays are never required; plain arrays still are", () => {
    for (const mode of ["create", "replace"] as const) {
      const result = validateBody(organization, { name: "acme" }, mode);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.details).toEqual([{ field: "tags", message: "Is required" }]);
      expect(validateBody(organization, { name: "acme", tags: [] }, mode).ok).toBe(true);
    }
    const nulled = validateBody(organization, { name: "acme", tags: [], members: null }, "create");
    expect(nulled.ok ? [] : nulled.details).toEqual([{ field: "members", message: "Cannot be null" }]);
  });
});

test("create and replace without the reference array store []", async () => {
  const database = memoryAdapter();
  await database.connect(models);
  const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config: resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {}) });
  const send = async (method: string, path: string, body: unknown) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const created = await send("POST", "/organizations", { name: "acme", tags: [] });
  expect(created.status).toBe(201);
  expect(created.body.members).toEqual([]);
  const replaced = await send("PUT", `/organizations/${created.body.id}`, { name: "acme 2", tags: ["x"] });
  expect(replaced.status).toBe(200);
  expect(replaced.body.members).toEqual([]);
  const nulled = await send("POST", "/organizations", { name: "x", tags: [], members: null });
  expect(nulled.status).toBe(400);
  expect(nulled.body.error.details).toEqual([{ field: "members", message: "Cannot be null" }]);
});

test("OpenAPI Create and Replace do not require reference arrays", () => {
  const doc = generateOpenApi({ models, routes: crudTable(models), packageJson: {} }) as any;
  for (const name of ["OrganizationCreate", "OrganizationReplace"]) {
    expect(doc.components.schemas[name].required).toContain("tags");
    expect(doc.components.schemas[name].required).not.toContain("members");
  }
});

test("generated Create types make reference arrays omittable", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, ...entities });
  await build(root);
  const types = await Bun.file(join(root, ".generated/types.ts")).text();
  expect(types).toMatch(/export type OrganizationCreate = \{[^}]*members\?: Array<string>;/);
  const check = join(root, "check.ts");
  writeFileSync(
    check,
    `import type { GeneratedRepositories } from "./.generated/types.ts";\ndeclare const repos: GeneratedRepositories;\nvoid repos.organizations.create({ name: "x", tags: [] });\n// @ts-expect-error tags are still required\nvoid repos.organizations.create({ name: "x" });\n`,
  );
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});
