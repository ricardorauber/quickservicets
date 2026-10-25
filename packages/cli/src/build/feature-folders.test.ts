import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, memoryAdapter, registerNative, registerProjectFeatures, resolveConfig } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { startDev, watchPaths, WATCHED_PATHS, type DevSession } from "../dev/dev.ts";
import { run } from "../run.ts";
import { writeNativeFolder } from "../testing/native.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build, type BuildSummary } from "./build.ts";

const config = (keys = "audit: {}") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const project = (files: Record<string, string>, keys?: string) => createLinkedProject({ "quickservice.config.ts": config(keys), ...files });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const greetings = { dir: "greetings", check: (value: unknown) => typeof value === "string" || "must default-export a string", description: "Greetings by name." };

const cleanups: (() => void)[] = [];
const native = (extra: Record<string, unknown> = {}, files?: Record<string, string>) => {
  if (files) cleanups.push(writeNativeFolder("audit", files));
  registerNative(defineFeature({ docs: { summary: "Test native." }, key: "audit", folders: { greetings }, ...extra }));
  cleanups.push(() => unregisterNative("audit"));
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  registerProjectFeatures([]);
});

describe("scanning folders", () => {
  test("project files are default exports in the registry, named by their path without extension", async () => {
    native();
    const root = project({
      "greetings/formal.ts": 'export default "Good day";\n',
      "greetings/casual/short.ts": 'export default "Hi";\n',
      "greetings/formal.test.ts": "throw new Error('tests are not scanned');\n",
    });
    await build(root);
    const app = await serveBuilt(root);
    expect(app.featureFolders.audit!.greetings!.get("formal")).toBe("Good day");
    expect([...app.featureFolders.audit!.greetings!.keys()]).toEqual(["casual/short", "formal"]);
    const { featureFolders } = await import(join(root, ".generated/features.ts"));
    expect(featureFolders.audit.greetings.get("formal")).toBe("Good day");
  });

  test("a rejected value or a missing default export fails the build naming the file", async () => {
    native();
    expect((await failure(() => build(project({ "greetings/bad.ts": "export default 42;\n" }))))).toHaveProperty("message", "greetings/bad.ts: must default-export a string");
    expect((await failure(() => build(project({ "greetings/none.ts": "export const text = 'Hi';\n" }))))).toHaveProperty("message", "greetings/none.ts: must have a default export");
  });

  test("the feature's own folder is scanned and a project file of the same name replaces its file", async () => {
    native({}, { "greetings/formal.ts": 'export default "Good day from the native";\n', "greetings/warm.ts": 'export default "Hello, friend";\n' });
    const root = project({ "greetings/formal.ts": 'export default "Good day";\n' });
    const lines: string[] = [];
    expect(await run(["build"], { log: (line) => lines.push(line), error: (line) => lines.push(line) }, root)).toBe(0);
    expect(lines).toContain("Override: greetings/formal.ts replaces @quickservice/core/features/audit/greetings/formal.ts from audit");
    const features = readFileSync(join(root, ".generated/features.ts"), "utf8");
    expect(features).toContain('import folder1 from "@quickservice/core/features/audit/greetings/warm.ts";');
    const app = await serveBuilt(root);
    expect(Object.fromEntries(app.featureFolders.audit!.greetings!)).toEqual({ formal: "Good day", warm: "Hello, friend" });
  });

  test("a project feature's folder is imported by relative paths", async () => {
    const feature = `import { defineFeature } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "audit", folders: { greetings: { dir: "greetings", description: "Greetings." } } });
`;
    const root = project({ "features/audit/index.ts": feature, "features/audit/greetings/formal.ts": 'export default "Good day";\n' });
    await build(root);
    expect(readFileSync(join(root, ".generated/features.ts"), "utf8")).toContain('import folder0 from "../features/audit/greetings/formal.ts";');
  });
});

describe("generated registry", () => {
  test("without feature folders the registry is empty", async () => {
    const root = project({}, "");
    await build(root);
    expect(readFileSync(join(root, ".generated/features.ts"), "utf8")).toContain("export const featureFolders: FeatureFolderRegistry = {};");
    expect((await serveBuilt(root)).featureFolders).toEqual({});
  });

  test("a disabled feature's folder is not scanned", async () => {
    native();
    const root = project({ "greetings/bad.ts": "export default 42;\n" }, "");
    await build(root);
    expect(readFileSync(join(root, ".generated/features.ts"), "utf8")).toContain("export const featureFolders: FeatureFolderRegistry = {};");
  });
});

describe("reserved and shared folders", () => {
  test("a reserved folder or one declared by two features fails resolving the config", () => {
    native({ folders: { greetings: { ...greetings, dir: "hooks" } } });
    expect(() => resolveConfig({ database: memoryAdapter(), audit: {} } as never, {})).toThrow("Folder hooks of audit is reserved by the core");
    cleanups.splice(0).forEach((cleanup) => cleanup());
    native();
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "notes", folders: { messages: { ...greetings } } }));
    cleanups.push(() => unregisterNative("notes"));
    expect(() => resolveConfig({ database: memoryAdapter(), audit: {}, notes: {} } as never, {})).toThrow("Folder greetings is declared by both audit and notes");
    expect(() => resolveConfig({ database: memoryAdapter(), audit: {} } as never, {})).not.toThrow();
  });
});

describe("dev watch paths", () => {
  test("dev watches jobs, features, env files and the enabled features' folders and watch paths", async () => {
    native({ watch: ["content/greetings.md"] });
    const summary = await build(project({}));
    expect(summary.watch).toEqual(["greetings", "content/greetings.md"]);
    expect(watchPaths(summary)).toEqual([...WATCHED_PATHS, "greetings", "content/greetings.md"]);
    expect(WATCHED_PATHS).toEqual(expect.arrayContaining(["entities", "endpoints", "hooks", "jobs", "features", "quickservice.config.ts", ".env"]));
    expect(watchPaths({})).toEqual(WATCHED_PATHS);
  });

  test("changing the enabled features in .env rebuilds with the new environment and watches the new paths", async () => {
    native();
    const root = project({});
    const builds: BuildSummary[] = [];
    const servers: (string | undefined)[] = [];
    const watched: string[][] = [];
    let onChange = () => {};
    const session = await startDev(root, {
      build: async (projectRoot, env) => {
        const summary = await build(projectRoot, env);
        builds.push(summary);
        return summary;
      },
      startServer: (_root, env) => {
        servers.push(env?.QS_AUDIT_ENABLED);
        return { stop: async () => {} };
      },
      watch: (_root, paths, callback) => {
        watched.push(paths);
        onChange = callback;
        return { close: () => {} };
      },
      scheduler: { setTimeout: (callback) => (callback(), 0), clearTimeout: () => {} },
      log: () => {},
      error: () => {},
    });
    expect(watched).toEqual([[...WATCHED_PATHS, "greetings"]]);
    writeFileSync(join(root, ".env"), "QS_AUDIT_ENABLED=false\n");
    onChange();
    await session.idle();
    expect(servers).toEqual([undefined, "false"]);
    expect(builds.map((summary) => summary.watch)).toEqual([["greetings"], []]);
    expect(watched).toEqual([[...WATCHED_PATHS, "greetings"], WATCHED_PATHS]);
    await session.stop();
  });

  test("editing a feature folder, a watch path or a project feature rebuilds through the real watcher", async () => {
    native({ watch: ["content"] });
    const root = project({
      "greetings/formal.ts": 'export default "Good day";\n',
      "content/notes.md": "# Notes\n",
      "features/extra/index.ts": 'import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "extra" });\n',
    });
    let builds = 0;
    let starts = 0;
    let session: DevSession | undefined;
    const waitFor = async (count: number) => {
      for (let tries = 0; tries < 100 && builds < count; tries++) await Bun.sleep(30);
      await session?.idle();
      return builds;
    };
    session = await startDev(root, {
      build: async (projectRoot, env) => (builds++, build(projectRoot, env)),
      startServer: () => (starts++, { stop: async () => {} }),
      log: () => {},
      error: () => {},
    });
    try {
      for (const [index, file] of ["greetings/formal.ts", "content/notes.md", "features/extra/index.ts"].entries()) {
        writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}\n`);
        expect(await waitFor(index + 2)).toBe(index + 2);
      }
      expect(starts).toBe(4);
    } finally {
      await session.stop();
    }
    expect(existsSync(join(root, ".generated/server.ts"))).toBe(true);
  });
});
