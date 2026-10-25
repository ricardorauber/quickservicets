import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, registerNative, registerProjectFeatures } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { run } from "../run.ts";
import { writeNativeFolder } from "../testing/native.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "./build.ts";

const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const POST = "/** @noteStamp */\nexport type Post = { title: string };\n";
const project = (files: Record<string, string>, keys = "") =>
  createLinkedProject({ "quickservice.config.ts": config(keys), "entities/User.ts": "export type User = { email: string };\n", ...files });
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const capture = async (args: string[], root: string) => {
  const lines: string[] = [];
  const code = await run(args, { log: (line) => lines.push(line), error: (line) => lines.push(line) }, root);
  return { code, lines };
};

/** A native's files import the core by relative paths; a project feature's import `@quickservice/core`. */
const files = (core: (path: string) => string) => ({
  "endpoints/notes/hello/get.ts": "/** @summary Says hello from notes */\nexport default () => ({ hello: \"notes\" });\n",
  "hooks/noteStamp.ts": `import { definePostHook } from ${JSON.stringify(core("hooks.ts"))};\nexport default definePostHook((data) => ({ ...(data as object), stamped: true }));\n`,
  "jobs/prune.ts": `import { job } from ${JSON.stringify(core("jobs/job.ts"))};\nexport default job({ every: "1h" }, async () => "pruned");\n`,
});
const NATIVE_FILES = files((path) => `../../../${path}`);
const PROJECT_FILES = files(() => "@quickservice/core");
const prefixed = (prefix: string, entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([path, content]) => [`${prefix}${path}`, content]));
const featureIndex = (key: string) =>
  `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ key: "${key}", endpoints: "./endpoints", hooks: "./hooks", jobs: "./jobs" });\n`;

const cleanups: (() => void)[] = [];
const notesNative = () => {
  cleanups.push(writeNativeFolder("notes", NATIVE_FILES));
  registerNative(defineFeature({ key: "notes", endpoints: "./endpoints", hooks: "./hooks", jobs: "./jobs" }));
  cleanups.push(() => unregisterNative("notes"));
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  registerProjectFeatures([]);
});

describe("scanning feature folders", () => {
  test("a native's endpoint, hook and job are served, run and listed with the feature's job name", async () => {
    notesNative();
    const root = project({ "entities/Post.ts": POST }, "notes: {}");
    await build(root);
    const app = await serveBuilt(root);
    expect((await app.get("/notes/hello")).body).toEqual({ hello: "notes" });
    expect((await app.request("POST", "/posts", { title: "First" })).body).toMatchObject({ title: "First", stamped: true });
    const list = await capture(["job", "list"], root);
    expect(list.code).toBe(0);
    expect(list.lines[1]).toStartWith("notes/prune");
  });

  test("feature folders follow the project's rules, reserved hook names included", async () => {
    const root = project(
      { "features/notes/index.ts": featureIndex("notes"), "features/notes/hooks/unique.ts": PROJECT_FILES["hooks/noteStamp.ts"]! },
      "notes: {}",
    );
    expect((await failure(() => build(root))).message).toBe('features/notes/hooks/unique.ts: "unique" is a reserved tag name and cannot be used as a hook');
    const nested = project(
      { "features/notes/index.ts": featureIndex("notes"), "features/notes/jobs/daily/report.ts": PROJECT_FILES["jobs/prune.ts"]!, "features/notes/jobs/report.test.ts": "throw new Error('not a job');" },
      "notes: {}",
    );
    await build(nested);
    expect(read(nested, ".generated/jobs.ts")).toContain('"notes/daily/report": true;');
  });
});

describe("generated imports", () => {
  test("natives are imported through the core package and project features by relative paths", async () => {
    notesNative();
    const root = project({ "entities/Post.ts": POST }, "notes: {}");
    await build(root);
    expect(read(root, ".generated/routes.ts")).toContain('import endpoint0 from "@quickservice/core/features/notes/endpoints/notes/hello/get.ts";');
    expect(read(root, ".generated/routes.ts")).toContain('import hook_noteStamp from "@quickservice/core/features/notes/hooks/noteStamp.ts";');
    expect(read(root, ".generated/jobs.ts")).toContain('import job0 from "@quickservice/core/features/notes/jobs/prune.ts";');
    expect(read(root, ".generated/jobs.ts")).toContain('["notes/prune", { ...job0, feature: "notes" }],');
    expect(read(root, ".generated/routes.ts")).toContain('feature: "notes", handler: endpoint0');

    const local = project({ "entities/Post.ts": POST, "features/notes/index.ts": featureIndex("notes"), ...prefixed("features/notes/", PROJECT_FILES) }, "notes: {}");
    await build(local);
    const routes = read(local, ".generated/routes.ts");
    expect(routes).toContain('import endpoint0 from "../features/notes/endpoints/notes/hello/get.ts";');
    expect(routes).toContain('import hook_noteStamp from "../features/notes/hooks/noteStamp.ts";');
    expect(read(local, ".generated/jobs.ts")).toContain('import job0 from "../features/notes/jobs/prune.ts";');
    expect(routes).not.toContain(local);
    expect((await (await serveBuilt(local)).get("/notes/hello")).body).toEqual({ hello: "notes" });
  });
});

describe("project overrides", () => {
  test("project files replace the feature's endpoint, hook and job, with one override line each", async () => {
    notesNative();
    const root = project(
      {
        "entities/Post.ts": POST,
        "endpoints/notes/hello/get.ts": 'export default () => ({ hello: "project" });\n',
        "hooks/noteStamp.ts": 'import { definePostHook } from "@quickservice/core";\nexport default definePostHook((data) => ({ ...(data as object), stamped: "project" }));\n',
        "jobs/notes/prune.ts": 'import { job } from "@quickservice/core";\nexport default job({ every: "2h" }, async () => "project");\n',
      },
      "notes: {}",
    );
    const { code, lines } = await capture(["build"], root);
    expect(code).toBe(0);
    expect(lines.slice(0, 3).sort()).toEqual([
      "Override: endpoints/notes/hello/get.ts replaces @quickservice/core/features/notes/endpoints/notes/hello/get.ts from notes",
      "Override: hooks/noteStamp.ts replaces @quickservice/core/features/notes/hooks/noteStamp.ts from notes",
      "Override: jobs/notes/prune.ts replaces @quickservice/core/features/notes/jobs/prune.ts from notes",
    ]);
    const app = await serveBuilt(root);
    expect((await app.get("/notes/hello")).body).toEqual({ hello: "project" });
    expect((await app.request("POST", "/posts", { title: "x" })).body.stamped).toBe("project");
    expect(read(root, ".generated/jobs.ts")).toContain('import job0 from "../jobs/notes/prune.ts";');
  });

  test("a feature endpoint overrides a generated route, and a project endpoint overrides the feature's", async () => {
    const feature = `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ key: "profiles", endpoints: "./endpoints" });\n`;
    const read_ = 'export default (_repos: unknown, req: { params: { id: string } }) => ({ id: req.params.id, email: "feature" });\n';
    const root = project({ "features/profiles/index.ts": feature, "features/profiles/endpoints/users/[id]/get.ts": read_ }, "profiles: {}");
    await build(root);
    expect((await (await serveBuilt(root)).get("/users/42")).body).toEqual({ id: "42", email: "feature" });
    const replaced = project(
      { "features/profiles/index.ts": feature, "features/profiles/endpoints/users/[id]/get.ts": read_, "endpoints/users/[id]/get.ts": 'export default () => ({ id: "7", email: "project" });\n' },
      "profiles: {}",
    );
    expect((await build(replaced)).overrides).toEqual(["Override: endpoints/users/[id]/get.ts replaces features/profiles/endpoints/users/[id]/get.ts from profiles"]);
    expect((await (await serveBuilt(replaced)).get("/users/42")).body).toEqual({ id: "7", email: "project" });
  });
});

describe("conflicts", () => {
  test("two features with the same hook, endpoint or job fail naming both files", async () => {
    const hook = PROJECT_FILES["hooks/noteStamp.ts"]!;
    const both = (path: string, content: string) =>
      project({ "features/alpha/index.ts": featureIndex("alpha"), "features/beta/index.ts": featureIndex("beta"), [`features/alpha/${path}`]: content, [`features/beta/${path}`]: content }, "alpha: {}, beta: {}");
    expect((await failure(() => build(both("hooks/noteStamp.ts", hook)))).message).toBe(
      "features/alpha/hooks/noteStamp.ts and features/beta/hooks/noteStamp.ts both define the hook noteStamp",
    );
    expect((await failure(() => build(both("endpoints/ping/get.ts", "export default () => 1;\n")))).message).toBe(
      "features/alpha/endpoints/ping/get.ts and features/beta/endpoints/ping/get.ts both define GET /ping",
    );
  });
});

describe("runtime filtering", () => {
  test("a feature disabled at startup has no routes and no scheduled jobs", async () => {
    notesNative();
    const root = project({}, "notes: {}");
    await build(root);
    const on = await serveBuilt(root);
    expect((await on.get("/notes/hello")).status).toBe(200);
    on.scheduler.start();
    expect([...on.scheduler.nextRuns.keys()]).toEqual(["notes/prune"]);
    on.scheduler.stop();
    const off = await serveBuilt(root, { QS_NOTES_ENABLED: "false" });
    expect((await off.get("/notes/hello")).status).toBe(404);
    off.scheduler.start();
    expect([...off.scheduler.nextRuns.keys()]).toEqual([]);
    off.scheduler.stop();
  });

  test("the OpenAPI document describes a feature endpoint from its JSDoc, and the summary counts feature files", async () => {
    notesNative();
    const root = project({ "entities/Post.ts": POST }, "notes: {}");
    const { lines } = await capture(["build"], root);
    expect(lines).toContain("Features added 1 endpoints, 1 hooks and 1 jobs.");
    expect(JSON.parse(read(root, ".generated/openapi.json")).paths["/notes/hello"].get.summary).toBe("Says hello from notes");
    expect((await capture(["build"], project({}))).lines).toEqual(["Built 3 entities, 0 custom endpoints and 0 hooks."]);
  });
});
