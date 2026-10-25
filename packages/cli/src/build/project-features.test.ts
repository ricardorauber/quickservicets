import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, integer, loadConfig, object, registerNative, registerProjectFeatures, resolveConfig, memoryAdapter } from "@quickservice/core";
import ts from "typescript";
import { unregisterNative } from "../../../core/src/features.ts";
import { run } from "../run.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const GREETING = `import { defineFeature, object, string } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "greeting", options: object({ text: string().default("Hi") }) });
`;
const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const project = (files: Record<string, string>, keys = "") =>
  createLinkedProject({ "quickservice.config.ts": config(keys), "entities/User.ts": "export type User = { email: string };\n", ...files });
const failure = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

afterEach(() => {
  registerProjectFeatures([]);
  unregisterNative("audit");
});

describe("discovery", () => {
  test("a project feature is found, enabled by its key and listed as a project feature", async () => {
    const resolved = await loadConfig(project({ "features/greeting/index.ts": GREETING }, "greeting: {}"), {});
    expect(resolved.features.map(({ key, options, native, project }) => ({ key, options, native, project }))).toEqual([
      { key: "greeting", options: { text: "Hi", enabled: true }, native: false, project: true },
    ]);
  });

  test("without its key it stays disabled; enabledByDefault enables it", async () => {
    const off = await loadConfig(project({ "features/greeting/index.ts": GREETING }), {});
    expect(off.features).toEqual([]);
    expect(off.disabledFeatures).toEqual(["events", "greeting"]);
    const byDefault = GREETING.replace('key: "greeting",', 'key: "greeting", enabledByDefault: true,');
    const on = await loadConfig(project({ "features/greeting/index.ts": byDefault }), {});
    expect(on.features.map((feature) => feature.key)).toEqual(["greeting"]);
  });

  test("a folder without a defineFeature default export fails", async () => {
    const root = project({ "features/greeting/index.ts": "export const greeting = 1;\n" });
    expect((await failure(() => loadConfig(root, {}))).message).toBe("features/greeting/index.ts: must default-export defineFeature(...)");
    const plain = project({ "features/greeting/index.ts": "export default { key: 'greeting' };\n" });
    expect((await failure(() => loadConfig(plain, {}))).message).toBe("features/greeting/index.ts: must default-export defineFeature(...)");
  });

  test("a definition whose key is not its folder fails", async () => {
    const root = project({ "features/greeting/index.ts": GREETING.replace('key: "greeting"', 'key: "hello"') });
    expect((await failure(() => build(root))).message).toBe("features/greeting/index.ts: the key is hello, but the folder is greeting");
  });

  test("project features follow the dependency rules of natives", async () => {
    const trail = `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "trail", requires: ["greeting"] });\n`;
    const root = project({ "features/greeting/index.ts": GREETING, "features/trail/index.ts": trail }, "trail: {}");
    expect((await failure(() => loadConfig(root, {}))).message).toBe("trail requires greeting; add greeting: {} to quickservice.config.ts");
  });
});

describe("replacing a native", () => {
  const audit = defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ level: integer().default(1) }) });
  const AUDIT = `import { defineFeature, object, string } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ sink: string().default("stdout") }) });
`;

  test("a project feature with a native's key replaces it", async () => {
    registerNative(audit);
    const root = project({ "features/audit/index.ts": AUDIT }, "audit: {}");
    const resolved = await loadConfig(root, {});
    expect(resolved.features.map(({ key, options, native, project }) => ({ key, options, native, project }))).toEqual([
      { key: "audit", options: { sink: "stdout", enabled: true }, native: false, project: true },
    ]);
    expect(resolved.features[0]!.definition).not.toBe(audit);
    expect(() => audit.options()).toThrow("audit is not enabled");
    expect((resolved.features[0]!.definition.options() as { sink: string }).sink).toBe("stdout");
  });

  test("the build prints the override line", async () => {
    registerNative(audit);
    const root = project({ "features/audit/index.ts": AUDIT }, "audit: {}");
    const logs: string[] = [];
    const code = await run(["build"], { log: (line) => logs.push(line), error: (line) => logs.push(line) }, root);
    expect(code).toBe(0);
    expect(logs).toEqual(["Override: features/audit replaces the audit native", "Built 3 entities, 0 custom endpoints, 0 hooks and 1 project features."]);
  });

  test("without a project feature the native is used", () => {
    registerNative(audit);
    registerProjectFeatures([]);
    const resolved = resolveConfig({ database: memoryAdapter(), audit: { level: 2 } } as never, {});
    expect(resolved.features.map(({ key, native, project }) => ({ key, native, project }))).toEqual([{ key: "audit", native: true, project: false }]);
  });
});

describe("imports", () => {
  test("files under features/ import the framework only from its public entries", async () => {
    const helper = 'import { createRepository } from "@quickservice/core/src/repository.ts";\nexport const x = createRepository;\n';
    const root = project({ "features/greeting/index.ts": GREETING, "features/greeting/lib/helper.ts": helper });
    expect((await failure(() => build(root))).message).toBe(
      "features/greeting/lib/helper.ts: imports @quickservice/core/src/repository.ts; project features import the framework only from @quickservice/core or @quickservice/core/testing",
    );
  });

  test("the public entries and other packages are allowed", async () => {
    const helper = 'import { runAttackSuite } from "@quickservice/core/testing";\nimport { join } from "node:path";\nexport const x = [runAttackSuite, join];\n';
    expect((await build(project({ "features/greeting/index.ts": GREETING, "features/greeting/helper.ts": helper }))).features).toBe(1);
  });
});

describe("generated files", () => {
  test("features.ts imports every project feature and types.ts types its key", async () => {
    const root = project({ "features/greeting/index.ts": GREETING }, "greeting: {}");
    const summary = await build(root);
    expect(summary.features).toBe(1);
    const features = readFileSync(join(root, ".generated/features.ts"), "utf8");
    expect(features).toContain('import feature0_greeting from "../features/greeting/index.ts";');
    expect(features).toContain('export const features: ProjectFeatureModule[] = [{ folder: "greeting", definition: feature0_greeting }];');
    const check = join(root, "check.ts");
    writeFileSync(
      check,
      `import "./.generated/types.ts";
import { memoryAdapter, type ServiceConfig } from "@quickservice/core";
export const ok: ServiceConfig = { database: memoryAdapter(), greeting: { text: "Hello" } };
export const on: ServiceConfig = { database: memoryAdapter(), greeting: true };
// @ts-expect-error text is a string option
export const wrong: ServiceConfig = { database: memoryAdapter(), greeting: { text: 5 } };
`,
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

  test("a project without features writes an empty features.ts and the usual summary", async () => {
    const root = project({});
    const logs: string[] = [];
    expect(await run(["build"], { log: (line) => logs.push(line), error: (line) => logs.push(line) }, root)).toBe(0);
    expect(logs).toEqual(["Built 3 entities, 0 custom endpoints and 0 hooks."]);
    expect(readFileSync(join(root, ".generated/features.ts"), "utf8")).toContain("export const features: ProjectFeatureModule[] = [];");
    expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).not.toContain("NativeFeatures");
  });

  test("the generated server registers project features before resolving the config", async () => {
    const root = project({ "features/greeting/index.ts": GREETING }, "greeting: {}");
    await build(root);
    const server = readFileSync(join(root, ".generated/server.ts"), "utf8");
    // startService registers the features it receives before it resolves the config.
    expect(server).toContain('import { featureFolders, features } from "./features.ts";');
    expect(server).toMatch(/startService\(\{[^}]*\bfeatures\b[^}]*\}\)/);
    const child = Bun.spawn(["bun", "-e", `import("${join(root, ".generated/features.ts")}").then(async ({ features }) => { const core = await import("@quickservice/core"); core.registerProjectFeatures(features); const config = core.resolveConfig((await import("${join(root, "quickservice.config.ts")}")).default, {}); console.log(JSON.stringify(config.features.map((f) => [f.key, f.options, f.project]))); })`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([["greeting", { text: "Hi", enabled: true }, true]]);
  });
});
