import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FEATURES_DIR, registerNative, registerProjectFeatures, type FeatureDefinition } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { cliPage } from "../../../../docs/scripts/reference.ts";
import { run } from "../run.ts";
import { writeNativeFolder } from "../testing/native.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "../build/build.ts";
import { rewriteImports } from "./eject.ts";

const NATIVE = {
  "index.ts": `import { defineFeature, object, string } from "../public.ts";
export default defineFeature({ key: "audit", options: object({ greeting: string().default("Hello") }), jobs: "./jobs", endpoints: "./endpoints" });
`,
  "jobs/prune.ts": `import { job } from "../../public.ts";
import { message } from "../lib/message.ts";
export default job({ every: "1h" }, async () => message("native"));
`,
  "lib/message.ts": "export const message = (from: string) => `pruned by ${from}`;\n",
  "endpoints/audit/status/get.ts": `import { message } from "../../../lib/message";
export default () => ({ status: message("native") });
`,
};

let remove = () => {};
let audit: FeatureDefinition;
beforeAll(async () => {
  remove = writeNativeFolder("audit", NATIVE);
  audit = (await import(join(NATIVE_FEATURES_DIR, "audit/index.ts"))).default as FeatureDefinition;
});
afterAll(() => remove());
afterEach(() => {
  unregisterNative("audit");
  registerProjectFeatures([]);
});

const project = (keys = "audit: {}") =>
  createLinkedProject({
    "quickservice.config.ts": `import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });\n`,
  });
const capture = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

describe("one file", () => {
  test("a job is copied to jobs/<key>/ with its imports rewritten, replaces the native's and runs edited", async () => {
    registerNative(audit);
    const root = project();
    expect(await capture(["eject", "audit", "--file", "jobs/prune.ts"], root)).toEqual({ code: 0, out: ["Copied jobs/audit/prune.ts; it now replaces the one from audit"], err: [] });
    const copy = readFileSync(join(root, "jobs/audit/prune.ts"), "utf8");
    expect(copy).toBe(`import { job } from "@quickservice/core";
import { message } from "@quickservice/core/features/audit/lib/message.ts";
export default job({ every: "1h" }, async () => message("native"));
`);
    writeFileSync(join(root, "jobs/audit/prune.ts"), copy.replace('message("native")', 'message("the copy")'));
    const built = await capture(["build"], root);
    expect(built.out).toContain("Override: jobs/audit/prune.ts replaces @quickservice/core/features/audit/jobs/prune.ts from audit");
    const ran = await capture(["job", "run", "audit/prune"], root);
    expect(ran.code).toBe(0);
    expect(ran.out[1]).toBe('Result: "pruned by the copy"');
  });

  test("an endpoint is copied to the same path in endpoints/", async () => {
    registerNative(audit);
    const root = project();
    expect((await capture(["eject", "audit", "--file", "endpoints/audit/status/get.ts"], root)).out).toEqual(["Copied endpoints/audit/status/get.ts; it now replaces the one from audit"]);
    expect(readFileSync(join(root, "endpoints/audit/status/get.ts"), "utf8")).toContain('import { message } from "@quickservice/core/features/audit/lib/message";');
    expect((await capture(["eject", "audit", "--file", "lib/message.ts"], root)).err).toEqual(["lib/message.ts is not a file of the entities, endpoints, hooks, jobs or folders of audit"]);
  });

  test("imports of the public entry become @quickservice/core and copied files keep relative imports", () => {
    const dir = join(NATIVE_FEATURES_DIR, "audit");
    const source = 'import { a } from "../../public.ts";\nimport { b } from "../lib/b.ts";\nimport c from "node:path";\nexport { d } from "./d";\n';
    expect(rewriteImports(source, join(dir, "jobs/x.ts"), dir, "audit", (path) => path === "jobs/d.ts")).toBe(
      'import { a } from "@quickservice/core";\nimport { b } from "@quickservice/core/features/audit/lib/b.ts";\nimport c from "node:path";\nexport { d } from "./d";\n',
    );
  });
});

describe("the whole native", () => {
  test("is copied into features/<key>/ as a project feature that replaces the native and keeps its behavior", async () => {
    registerNative(audit);
    const root = project();
    await build(root);
    const before = await (await serveBuilt(root)).get("/audit/status");
    const { code, out } = await capture(["eject", "audit"], root);
    expect(code).toBe(0);
    expect(out).toEqual([
      "Wrote features/audit/endpoints/audit/status/get.ts",
      "Wrote features/audit/index.ts",
      "Wrote features/audit/jobs/prune.ts",
      "Wrote features/audit/lib/message.ts",
      "features/audit/ now replaces the audit native.",
      "quickservice.config.ts keeps audit: {…} unchanged.",
      "Delete features/audit/ to go back to the native.",
    ]);
    expect(readFileSync(join(root, "features/audit/index.ts"), "utf8")).toStartWith('import { defineFeature, object, string } from "@quickservice/core";');
    expect(readFileSync(join(root, "features/audit/jobs/prune.ts"), "utf8")).toContain('import { message } from "../lib/message.ts";');
    const built = await capture(["build"], root);
    expect(built.code).toBe(0);
    expect(built.out).toContain("Override: features/audit replaces the audit native");
    const after = await (await serveBuilt(root)).get("/audit/status");
    expect(after).toEqual(before);
    expect(after.body).toEqual({ status: "pruned by native" });
    expect((await capture(["job", "list"], root)).out[1]).toStartWith("audit/prune");
  });
});

describe("destinations and keys", () => {
  test("existing destinations stop unless forced, a dry run writes nothing, and unknown keys list the enabled natives", async () => {
    registerNative(audit);
    const root = project();
    const dry = await capture(["eject", "audit", "--dry-run"], root);
    expect(dry.out).toContain("Would write features/audit/index.ts");
    expect(existsSync(join(root, "features/audit"))).toBe(false);
    expect((await capture(["eject", "audit"], root)).code).toBe(0);
    expect(await capture(["eject", "audit"], root)).toEqual({ code: 1, out: [], err: ["features/audit already exists; use --force to overwrite"] });
    writeFileSync(join(root, "features/audit/lib/message.ts"), "changed");
    expect((await capture(["eject", "audit", "--force"], root)).code).toBe(0);
    expect(readFileSync(join(root, "features/audit/lib/message.ts"), "utf8")).toBe(NATIVE["lib/message.ts"]);

    const single = project();
    await capture(["eject", "audit", "--file", "jobs/prune.ts"], single);
    expect((await capture(["eject", "audit", "--file", "jobs/prune.ts"], single)).err).toEqual(["jobs/audit/prune.ts already exists; use --force to overwrite"]);
    expect(await capture(["eject", "nope"], single)).toEqual({ code: 1, out: [], err: ["nope is not an enabled native feature; enabled natives: audit"] });
    expect((await capture(["eject", "audit"], project(""))).err).toEqual(["audit is not an enabled native feature; enabled natives: none"]);
  });
});

describe("reference", () => {
  test("the CLI reference documents eject and its flags", () => {
    const page = cliPage();
    expect(page).toContain("## `eject`");
    expect(page).toContain("quickservice eject <key> [--file <path>] [--dry-run] [--force]");
  });
});
