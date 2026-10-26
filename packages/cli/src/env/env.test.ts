import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, list, loadConfig, registerNative, string, url } from "@quickservicets/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { referencePages } from "../../../../docs/scripts/reference.ts";
import { build } from "../build/build.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { ENV_EXAMPLE_HEADER, envExampleContent, HAND_WRITTEN_ENV_EXAMPLE } from "./env-example.ts";
import { envCheck, parseEnvFile, projectEnvironment } from "./env-check.ts";

const SECRET = "sk_live_123";
const CONFIG = `import { defineConfig, integer, memoryAdapter, secret, url } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  env: { DATABASE_URL: url().describe("Main database"), STRIPE_KEY: secret(), REPORT_HOUR: integer().default(6) },
});
`;
const NO_ENV = 'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter() });\n';
const project = (files: Record<string, string> = {}) =>
  createLinkedProject({ "quickservicets.config.ts": CONFIG, "entities/User.ts": "export type User = { email: string };\n", ...files });
const valid = { DATABASE_URL: "https://db.example.com", STRIPE_KEY: SECRET };
const withVariables = async <T>(set: Record<string, string>, body: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, set);
  try {
    return await body();
  } finally {
    for (const name of Object.keys(set)) delete process.env[name];
  }
};
const read = (root: string) => readFileSync(join(root, ".env.example"), "utf8");

afterEach(() => unregisterNative("example"));

describe(".env.example", () => {
  test("one block per variable, with secrets and variables without a default left empty", async () => {
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "example", enabledByDefault: true, env: { EXAMPLE_API_URL: url().optional().describe("Example API") } }));
    const root = project();
    await withVariables(valid, () => build(root));
    expect(read(root)).toBe(`${ENV_EXAMPLE_HEADER}

# Main database
# Type: url
# required
DATABASE_URL=

# Type: secret
# required
STRIPE_KEY=

# Type: integer
# default: 6
REPORT_HOUR=6

# Example API
# Type: url
# optional
# Declared by: example
EXAMPLE_API_URL=
`);
  });

  test("defaults are written as text, lists comma-separated", () => {
    const content = envExampleContent([{ name: "TAGS", owner: "the project", schema: list(string()).default(["a", "b"]) }]);
    expect(content).toContain("# default: a,b\nTAGS=a,b");
  });

  test("written only when it changes, removed with env, and a hand-written file is never touched", async () => {
    const root = project();
    await withVariables(valid, () => build(root));
    const file = join(root, ".env.example");
    const before = statSync(file).mtimeMs;
    await Bun.sleep(20);
    await withVariables(valid, () => build(root));
    expect(statSync(file).mtimeMs).toBe(before);
    // A project whose config no longer declares variables (a new folder, since config modules are cached per process).
    const withoutEnv = project({ "quickservicets.config.ts": NO_ENV, ".env.example": read(root) });
    await build(withoutEnv);
    expect(existsSync(join(withoutEnv, ".env.example"))).toBe(false);

    const handWritten = project({ ".env.example": "DATABASE_URL=postgres://localhost/app\n" });
    expect((await withVariables(valid, () => build(handWritten))).warnings).toContain(HAND_WRITTEN_ENV_EXAMPLE);
    expect(readFileSync(join(handWritten, ".env.example"), "utf8")).toBe("DATABASE_URL=postgres://localhost/app\n");
    const handWrittenWithoutEnv = project({ "quickservicets.config.ts": NO_ENV, ".env.example": "DATABASE_URL=postgres://localhost/app\n" });
    await build(handWrittenWithoutEnv);
    expect(readFileSync(join(handWrittenWithoutEnv, ".env.example"), "utf8")).toBe("DATABASE_URL=postgres://localhost/app\n");
  });
});

describe("env check", () => {
  test("one status line per variable, secrets masked, and exit 1 when one is invalid", async () => {
    const root = project({ ".env": `STRIPE_KEY=${SECRET}\nDATABASE_URL=nope\n` });
    const result = await envCheck(root, {});
    expect(result.lines).toEqual(["DATABASE_URL invalid: expected an absolute http or https URL (got \"nope\")", "STRIPE_KEY ok [secret]", "REPORT_HOUR default 6"]);
    expect(result.code).toBe(1);
    const fixed = await envCheck(root, { DATABASE_URL: "https://db.example.com" });
    expect(fixed.lines[0]).toBe("DATABASE_URL ok https://db.example.com");
    expect(fixed.code).toBe(0);
    expect((await envCheck(root, { DATABASE_URL: "" })).code).toBe(1);
  });

  test("missing variables fail, and set overrides and unknown QS_ variables are listed", async () => {
    const root = project();
    const result = await envCheck(root, { QS_SERVER_PORT: "4000", QS_SERVR_PORT: "1", QS_FILES_SIGNING_SECRET: SECRET });
    expect(result.lines).toEqual([
      "DATABASE_URL missing",
      "STRIPE_KEY missing",
      "REPORT_HOUR default 6",
      "QS_FILES_SIGNING_SECRET sets files.signingSecret = [secret]",
      "QS_SERVER_PORT sets server.port = 4000",
    ]);
    expect(result.errors).toEqual(["Warning: Unknown environment variable QS_SERVR_PORT (did you mean QS_SERVER_PORT?)"]);
    expect(result.code).toBe(1);
  });

  test("an invalid override is reported and fails", async () => {
    const result = await envCheck(project(), { ...valid, QS_SERVER_PORT: "abc" });
    expect(result.errors).toEqual(['Invalid QS_SERVER_PORT (server.port): expected an integer between 1 and 65535, got "abc"']);
    expect(result.code).toBe(1);
  });

  test("the command prints the lines and exits with the code", async () => {
    const lines: string[] = [];
    const code = await withVariables(valid, () => run(["env", "check"], { log: (line) => lines.push(line), error: (line) => lines.push(line) }, project()));
    expect(code).toBe(0);
    expect(lines).toEqual(["DATABASE_URL ok https://db.example.com", "STRIPE_KEY ok [secret]", "REPORT_HOUR default 6"]);
  });

  test(".env files are read as Bun reads them, the process winning", () => {
    expect(parseEnvFile('A=1\nexport B="two words"\n# comment\nC=3 # note\nD=\'x\'')).toEqual({ A: "1", B: "two words", C: "3", D: "x" });
    const root = project({ ".env": "A=env\nB=env\nC=env\n", ".env.development": "B=development\n", ".env.local": "C=local\n", ".env.test": "B=test\n" });
    expect(projectEnvironment(root, { A: "process" })).toMatchObject({ A: "process", B: "development", C: "local" });
    expect(projectEnvironment(root, { NODE_ENV: "test" })).toMatchObject({ A: "env", B: "test", C: "env" });
  });
});

describe("secrets", () => {
  test("the resolved config and env print [secret]", async () => {
    const root = project();
    const config = await withVariables({ ...valid, QS_FILES_SIGNING_SECRET: SECRET }, () => loadConfig(root));
    const json = JSON.stringify(config);
    expect(json).toContain("[secret]");
    expect(json).not.toContain(SECRET);
    expect(config.files.signingSecret).toBe(SECRET);
    const { env } = await import("@quickservicets/core");
    expect(Bun.inspect(env)).toContain("[secret]");
    expect(Bun.inspect(env)).not.toContain(SECRET);
    expect((env as unknown as Record<string, string>).STRIPE_KEY).toBe(SECRET);
  });

  test("no output of the build, the reference, env check or a failed startup holds a secret", async () => {
    const root = project({ ".env": `STRIPE_KEY=${SECRET}\n` });
    const outputs: string[] = [];
    const collect = { log: (line: string) => outputs.push(line), error: (line: string) => outputs.push(line) };
    await withVariables({ ...valid, QS_FILES_SIGNING_SECRET: SECRET }, async () => {
      expect(await run(["build"], collect, root)).toBe(0);
      expect(await run(["env", "check"], collect, root)).toBe(0);
    });
    outputs.push(read(root), readFileSync(join(root, ".generated/types.ts"), "utf8"), readFileSync(join(root, ".generated/openapi.json"), "utf8"));
    outputs.push(...Object.values(referencePages()));
    const failed = project({ "quickservicets.config.ts": CONFIG.replace("STRIPE_KEY: secret()", "STRIPE_KEY: secret().min(40)") });
    await withVariables(valid, async () => {
      expect(await run(["build"], collect, failed)).toBe(3);
    });
    const server = Bun.spawn(["bun", "-e", `import(${JSON.stringify(join(failed, "quickservicets.config.ts"))}).then(async (m) => (await import("@quickservicets/core")).resolveConfig(m.default))`], {
      cwd: failed,
      env: { ...process.env, ...valid },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text(), server.exited]);
    expect(stderr).toContain("STRIPE_KEY: expected a string of at least 40 characters, got [secret]");
    outputs.push(stdout, stderr);
    expect(outputs.filter((output) => output.includes(SECRET))).toEqual([]);
  }, 30_000);
});
