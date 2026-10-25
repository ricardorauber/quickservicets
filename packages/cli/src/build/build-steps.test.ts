import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFeatureLifecycle, generatedPath, loadConfig, registerProjectFeatures, type LogEntry } from "@quickservice/core";
import { startDev, stepsFor } from "../dev/dev.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const runs = globalThis as unknown as Record<string, number>;
/** A project feature whose build step writes `hello.txt` from its greetings, counting its runs in a global. */
const greeter = (key: string, body = "") => `import { defineFeature } from "@quickservice/core";
import { readFileSync } from "node:fs";
export default defineFeature({ docs: { summary: "Test native." },
  key: "${key}",
  folders: { greetings: { dir: "greetings", description: "Greetings." } },
  async build(ctx) {
    ${body}
    await ctx.cached(["greetings"], async () => {
      (globalThis as any)["${key}"] = ((globalThis as any)["${key}"] ?? 0) + 1;
      ctx.log(\`\${Object.values(ctx.folders).flat().length} greetings\`);
      await ctx.write("hello.txt", ctx.folders.greetings!.map((file) => readFileSync(file.path, "utf8").trim()).join("\\\\n"));
    });
  },
  setup(ctx) {
    ctx.logger.info({ message: "read", text: readFileSync(ctx.generated("hello.txt"), "utf8") });
  },
});
`;
const project = (key: string, keys = `${key}: {}`, body = "") =>
  createLinkedProject({ "quickservice.config.ts": config(keys), [`features/${key}/index.ts`]: greeter(key, body), "greetings/formal.ts": 'export default "Good day";\n' });
const capture = async (args: string[], root: string) => {
  const lines: string[] = [];
  const code = await run(args, { log: (line) => lines.push(line), error: (line) => lines.push(line) }, root);
  return { code, lines };
};

afterEach(() => registerProjectFeatures([]));

describe("running build steps", () => {
  test("a step writes into .generated/<key>/ after the rest, prints its timing, and setup reads its output", async () => {
    const root = project("greeta");
    const { code, lines } = await capture(["build"], root);
    expect(code).toBe(0);
    expect(readFileSync(join(root, ".generated/greeta/hello.txt"), "utf8")).toBe('export default "Good day";');
    expect(lines).toContain("greeta: 1 greetings");
    expect(lines.find((line) => line.startsWith("Built greeta in "))).toMatch(/^Built greeta in \d+ ms$/);
    expect(lines).toContain("Ran 1 feature build steps.");
    const resolved = await loadConfig(root, {});
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: () => {}, error: () => {} };
    const lifecycle = createFeatureLifecycle({ features: resolved.features, config: { ...resolved, logger }, models: [], worker: { index: 0, count: 1, runsScheduledWork: true }, generatedDir: join(root, ".generated") });
    await lifecycle.setup();
    expect(entries.find((entry) => entry.message === "read")!.text).toBe('export default "Good day";');
  });

  test("steps run in feature order with the context the feature needs", async () => {
    const order: unknown[] = [];
    const recorder = (key: string, extra = "") => `import { defineFeature, object, string } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "${key}", ${extra} options: object({ label: string().default("${key}") }), build(ctx) {
  (globalThis as any).order.push({ key: ctx.options.label, outDir: ctx.outDir.endsWith(".generated/${key}"), root: ctx.root, models: ctx.models.map((model) => model.key), production: ctx.production });
} });
`;
    (globalThis as unknown as { order: unknown[] }).order = order;
    const root = createLinkedProject({
      "quickservice.config.ts": config("second: {}, first: {}"),
      "entities/Post.ts": "export type Post = { title: string };\n",
      "features/first/index.ts": recorder("first"),
      "features/second/index.ts": recorder("second", 'after: ["first"],'),
    });
    await build(root, { QS_FIRST_LABEL: "from env" });
    expect(order).toEqual([
      { key: "from env", outDir: true, root, models: ["Post", "File", "Media"], production: false },
      { key: "second", outDir: true, root, models: ["Post", "File", "Media"], production: false },
    ]);
    expect(existsSync(join(root, ".generated/first"))).toBe(true);
  });
});

describe("the cache helper", () => {
  test("unchanged inputs skip the work; a changed file runs it again", async () => {
    const root = project("greetb");
    await capture(["build"], root);
    expect(runs.greetb).toBe(1);
    const second = await capture(["build"], root);
    expect(second.lines).toContain("greetb is up to date");
    expect(runs.greetb).toBe(1);
    writeFileSync(join(root, "greetings/formal.ts"), 'export default "Good evening";\n');
    const third = await capture(["build"], root);
    expect(third.lines.some((line) => line.startsWith("Built greetb in "))).toBe(true);
    expect(runs.greetb).toBe(2);
    expect(readFileSync(join(root, ".generated/greetb/hello.txt"), "utf8")).toBe('export default "Good evening";');
  });
});

describe("failures", () => {
  test("a step that throws fails the build with its key", async () => {
    const root = project("greetc", "greetc: {}", 'throw new Error("boom");');
    expect(await capture(["build"], root)).toEqual({ code: 1, lines: ["greetc: build: boom"] });
  });
});

describe("dev", () => {
  test("a change in the feature's folder reruns its step and restarts the server", async () => {
    const root = project("greetd");
    let onChange: (changed?: string) => void = () => {};
    const builds: (readonly string[] | undefined)[] = [];
    let starts = 0;
    const session = await startDev(root, {
      build: async (projectRoot, env, options) => (builds.push(options?.steps), build(projectRoot, env, options)),
      startServer: () => (starts++, { stop: async () => {} }),
      watch: (_root, _paths, callback) => ((onChange = callback), { close: () => {} }),
      scheduler: { setTimeout: (callback) => (callback(), 0), clearTimeout: () => {} },
      log: () => {},
      error: () => {},
    });
    expect(runs.greetd).toBe(1);
    writeFileSync(join(root, "greetings/formal.ts"), 'export default "Hi";\n');
    onChange("greetings/formal.ts");
    await session.idle();
    expect(builds).toEqual([undefined, ["greetd"]]);
    expect(runs.greetd).toBe(2);
    expect(starts).toBe(2);
    onChange("entities/Post.ts");
    await session.idle();
    expect(builds[2]).toBeUndefined();
    await session.stop();
    expect(stepsFor(new Set(["greetings/a.ts", "content/b.md"]), { one: ["greetings"], two: ["content"] })).toEqual(["one", "two"]);
    expect(stepsFor(new Set(["greetings/a.ts", "hooks/x.ts"]), { one: ["greetings"] })).toBeUndefined();
  });
});

describe("cleanup and paths", () => {
  test("a disabled feature's folder is deleted, and paths may not leave the output folder", async () => {
    const root = project("greete");
    await build(root);
    expect(existsSync(join(root, ".generated/greete/hello.txt"))).toBe(true);
    process.env.QS_GREETE_ENABLED = "false";
    try {
      await build(root);
    } finally {
      delete process.env.QS_GREETE_ENABLED;
    }
    expect(existsSync(join(root, ".generated/greete"))).toBe(false);

    const escaping = project("greetf", "greetf: {}", 'await ctx.write("../../escaped.txt", "x");');
    expect(await capture(["build"], escaping)).toEqual({ code: 1, lines: ["greetf: build: Path ../../escaped.txt leaves the generated folder of greetf"] });
    expect(existsSync(join(escaping, "escaped.txt"))).toBe(false);
    expect(() => generatedPath("/project/.generated/greet", "../x", "greet")).toThrow("Path ../x leaves the generated folder of greet");
    expect(() => generatedPath("/project/.generated/greet", "/etc/passwd", "greet")).toThrow("Path /etc/passwd leaves the generated folder of greet");
    expect(generatedPath("/project/.generated/greet", "assets/site.css", "greet")).toBe("/project/.generated/greet/assets/site.css");
  });
});
