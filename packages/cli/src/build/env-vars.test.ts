import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineFeature, duration, integer, list, loadConfig, number, object, oneOf, registerNative, secret, size, string, url } from "@quickservice/core";
import ts from "typescript";
import { clearEnvValues } from "../../../core/src/env-vars.ts";
import { unregisterNative } from "../../../core/src/features.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";
import { envVarsLines, optionValueType } from "./generate-types.ts";

const CONFIG = `import { defineConfig, integer, memoryAdapter, secret, url } from "@quickservice/core";
export default defineConfig({
  database: memoryAdapter(),
  env: { DATABASE_URL: url().protocols(["postgres"]), STRIPE_KEY: secret(), REPORT_HOUR: integer().min(0).max(23).default(6) },
});
`;
const REPORT = `import { env, type Endpoint } from "@quickservice/core";

/** @summary Next report hour */
const handler: Endpoint<unknown, { next: number }> = () => ({ next: env.REPORT_HOUR + 1 });

export default handler;
`;
const project = (files: Record<string, string> = {}) =>
  createLinkedProject({ "quickservice.config.ts": CONFIG, "entities/User.ts": "export type User = { email: string };\n", ...files });
const variables = { DATABASE_URL: "postgres://localhost/app", STRIPE_KEY: "sk_test_1" };

function typeErrors(root: string, source: string): string[] {
  const check = join(root, "check.ts");
  writeFileSync(check, source);
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
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

const withVariables = async <T>(set: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, set);
  try {
    return await run();
  } finally {
    for (const name of Object.keys(set)) delete process.env[name];
  }
};

afterEach(() => unregisterNative("example"));

describe("generated EnvVars", () => {
  test("every kind has its type, and optional variables without a default may be undefined", () => {
    expect(optionValueType(string())).toBe("string");
    expect(optionValueType(url())).toBe("string");
    expect(optionValueType(secret())).toBe("string");
    expect(optionValueType(duration())).toBe("string");
    expect(optionValueType(size())).toBe("string | number");
    expect(optionValueType(number())).toBe("number");
    expect(optionValueType(integer())).toBe("number");
    expect(optionValueType(boolean())).toBe("boolean");
    expect(optionValueType(oneOf(["a", "b"]))).toBe('"a" | "b"');
    expect(optionValueType(list(string()))).toBe("string[]");
    expect(optionValueType(list(oneOf(["a", "b"])))).toBe('("a" | "b")[]');
    expect(optionValueType(object({ x: integer(), y: string().optional() }))).toBe('{ "x": number; "y"?: string }');
    expect(envVarsLines([{ name: "A", schema: url().optional() }, { name: "B", schema: integer().optional().default(1) }])).toEqual(["    A: string | undefined;", "    B: number;"]);
  });

  test("the build types env with the declared variables, and an endpoint reads them typed", async () => {
    const root = project({ "endpoints/report/get.ts": REPORT });
    await withVariables(variables, () => build(root));
    const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
    expect(types).toContain("  interface EnvVars {\n    DATABASE_URL: string;\n    STRIPE_KEY: string;\n    REPORT_HOUR: number;\n  }");
    expect(
      typeErrors(
        root,
        `import "./.generated/types.ts";
import { env } from "@quickservice/core";
export const hour: number = env.REPORT_HOUR;
// @ts-expect-error only declared variables exist
export const nope = env.NOPE;
// @ts-expect-error the hour is a number
export const text: string = env.REPORT_HOUR;
`,
      ),
    ).toEqual([]);
  });

  test("the generated server reads the variables at startup", async () => {
    const root = project({ "endpoints/report/get.ts": REPORT });
    await withVariables(variables, () => build(root));
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], { cwd: root, env: { ...process.env, ...variables, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    try {
      let body: unknown;
      for (let attempt = 0; attempt < 100 && body === undefined; attempt++) {
        await Bun.sleep(50);
        body = await fetch(`http://localhost:${port}/report`).then((response) => response.json(), () => undefined);
      }
      expect(body).toEqual({ next: 7 });
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);

  test("startup fails listing every missing variable", async () => {
    const root = project();
    await withVariables(variables, () => build(root));
    const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], { cwd: root, env: { ...process.env, REPORT_HOUR: "25" }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Invalid environment:\n  DATABASE_URL is required (url)\n  STRIPE_KEY is required (secret)\n  REPORT_HOUR: expected an integer of at most 23, got \"25\"");
  }, 30_000);

  test("a feature's variables are typed with the project's, and a conflicting kind fails", async () => {
    registerNative(defineFeature({ key: "example", enabledByDefault: true, env: { EXAMPLE_API_URL: url().optional() } }));
    const root = project();
    await withVariables(variables, () => build(root));
    expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).toContain("    EXAMPLE_API_URL: string | undefined;");
    const conflicting = project({ "quickservice.config.ts": CONFIG.replace("REPORT_HOUR:", "EXAMPLE_API_URL: integer(), REPORT_HOUR:") });
    await expect(withVariables(variables, () => build(conflicting))).rejects.toThrow("EXAMPLE_API_URL is declared as integer by the project and as url by example");
  });

  test("reading env in the config file fails with how to fix it", async () => {
    clearEnvValues();
    const root = project({
      "quickservice.config.ts": `import { defineConfig, env, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), server: { publicUrl: String(env.DATABASE_URL) } });
`,
    });
    await expect(loadConfig(root, {})).rejects.toThrow("env.DATABASE_URL was read before the configuration was resolved; use process.env inside quickservice.config.ts");
  });

  test("a project without env keeps its types, with an empty EnvVars", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": 'import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter() });\n', "entities/User.ts": "export type User = { email: string };\n" });
    await build(root);
    const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
    expect(types).toContain('declare module "@quickservice/core" {\n  interface Repositories extends GeneratedRepositories {}\n  interface EnvVars {}\n}');
  });
});
