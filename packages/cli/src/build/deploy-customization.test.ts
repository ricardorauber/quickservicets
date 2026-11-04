import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMachinePlatform, createServiceHandler, handleLambdaEvent, memoryAdapter, type ServiceConfig } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const config = (extra = "", head = "") => `import { defineConfig } from "@quickservicets/core";\n${head}\nexport default defineConfig({ ${extra} });\n`;
const project = (configText: string, files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "blog" }), "quickservicets.config.ts": configText, "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  roots.push(root);
  return root;
};

const cli = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

const routes = (root: string) => readFileSync(join(root, ".generated/routes.ts"), "utf8");

describe("level 0 and variables", () => {
  test("a project without a deploy key builds for cloud-run, and QS_DEPLOY_LAZY_ROUTES=off keeps eager imports on lambda", async () => {
    const root = project(config());
    const built = await cli(["build", "--target", "cloud-run"], root);
    expect(built.code).toBe(0);
    expect(existsSync(join(root, "dist/cloud-run/service.yaml"))).toBe(true);
    const lambda = project(config('deploy: { target: "lambda" }'), { "endpoints/hello/get.ts": "export default () => ({ hello: true });\n" });
    await build(lambda, {});
    expect(routes(lambda)).toContain("lazyEndpoint(");
    await build(lambda, { QS_DEPLOY_LAZY_ROUTES: "off" });
    expect(routes(lambda)).not.toContain("lazyEndpoint(");
    expect(routes(lambda)).toContain('import endpoint0 from "../endpoints/hello/get.ts";');
  }, 180_000);
});

describe("the @preload tag", () => {
  test("with lazy routes an endpoint tagged @preload is imported at startup while the others wait", async () => {
    const root = project(config('deploy: { lazyRoutes: "on" }'), {
      "endpoints/fast/get.ts": "/** @preload */\nexport default () => ({ fast: true });\n",
      "endpoints/slow/get.ts": "export default () => ({ slow: true });\n",
      "entities/Note.ts": "/** @preload */\nexport type Note = { text: string };\n",
      "endpoints/notes/get.ts": "export default () => ({ data: [], total: 0 });\n",
    });
    await build(root, {});
    const table = routes(root);
    expect(table).toContain('import endpoint0 from "../endpoints/fast/get.ts";');
    expect(table).toContain('lazyEndpoint("endpoints/slow/get.ts"');
    // The override of a @preload entity's route loads at startup too.
    expect(table).toContain('from "../endpoints/notes/get.ts";');
    expect(table).not.toContain('lazyEndpoint("endpoints/notes/get.ts"');
  });
});

describe("build and platform hooks", () => {
  test("beforeBundle adding a define changes the bundle, and afterBundle receives the sizes", async () => {
    const root = project(
      config(
        'deploy: { beforeBundle: (input) => ({ ...input, define: { ...input.define, "process.env.BUILD_LABEL": JSON.stringify("release-42") } }), afterBundle: (output) => void bundles.push(output) }',
        "export const bundles: { target: string; files: string[]; sizes: Record<string, number> }[] = [];",
      ),
      { "endpoints/label/get.ts": "export default () => ({ label: process.env.BUILD_LABEL });\n" },
    );
    expect((await cli(["build"], root)).code).toBe(0);
    expect(readFileSync(join(root, "dist/server/server.js"), "utf8")).toContain("release-42");
    const { bundles } = (await import(join(root, "quickservicets.config.ts"))) as { bundles: { target: string; files: string[]; sizes: Record<string, number> }[] };
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.target).toBe("server");
    expect(bundles[0]!.files).toContain("server.js");
    expect(bundles[0]!.sizes["server.js"]).toBeGreaterThan(0);
  }, 120_000);

  test("onPlatformEvent answering a custom Lambda event keeps it from failing as unsupported", async () => {
    const root = project(config());
    await build(root, {});
    const dir = join(root, ".generated");
    const inputs = {
      models: (await import(join(dir, "models.ts"))).models,
      ...(await import(join(dir, "routes.ts"))),
      jobs: (await import(join(dir, "jobs.ts"))).jobs,
      ...(await import(join(dir, "features.ts"))),
      generatedDir: dir,
      env: {},
    };
    const projectConfig = {
      database: memoryAdapter(),
      logger: { info() {}, warn() {}, error() {} },
      deploy: { onPlatformEvent: ({ event }: { event: unknown }) => ((event as { warmup?: boolean }).warmup ? { warmed: true } : undefined) },
    } as unknown as ServiceConfig;
    const handler = createServiceHandler({ ...inputs, projectConfig, handleSigterm: false });
    try {
      await handler.init();
      const context = { awsRequestId: "r", deadlineMs: Date.now() + 10_000 };
      expect(await handleLambdaEvent(handler, { warmup: true }, context)).toEqual({ warmed: true });
      await expect(handleLambdaEvent(handler, { other: true }, context)).rejects.toThrow("Unsupported Lambda event");
    } finally {
      await handler.stop();
    }
  });
});

describe("override files and custom targets", () => {
  test("deploy/cloud-run/Dockerfile replaces the generated one, and deploy/lambda/entry.ts replaces the bootstrap entry", async () => {
    const root = project(config(`deploy: { platform: "${buildMachinePlatform()}" }`), {
      "deploy/cloud-run/Dockerfile": "FROM scratch\n",
      "deploy/lambda/entry.ts": 'console.log("custom bootstrap");\n',
    });
    const cloudRun = await cli(["build", "--target", "cloud-run"], root);
    expect(cloudRun.code).toBe(0);
    expect(readFileSync(join(root, "dist/cloud-run/Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(cloudRun.out).toContain("Override: deploy/cloud-run/Dockerfile replaces the generated Dockerfile");
    const lambda = await cli(["build", "--target", "lambda"], root);
    expect(lambda.code).toBe(0);
    expect(lambda.out).toContain("Override: deploy/lambda/entry.ts replaces the generated entry.ts");
    const ran = Bun.spawnSync([join(root, "dist/lambda/bootstrap")], { cwd: mkdtempSync(join(tmpdir(), "qs-custom-bootstrap-")), stdout: "pipe", stderr: "pipe" });
    expect(ran.stdout.toString()).toBe("custom bootstrap\n");
  }, 240_000);

  test("a zip target of the project builds with --target zip; a feature adds one through its API; built-in names conflict", async () => {
    const zip = `deploy: { targets: { zip: { async build({ bundle, outDir, log }) { await Bun.write(outDir + "/service.zip", Bun.gzipSync(await Bun.file(bundle).bytes())); log("zip: service.zip"); } } } }`;
    const root = project(config(zip), {
      "features/archive/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "archive", enabledByDefault: true, after: ["deploy"], setup(ctx) { ctx.feature("deploy").target("tarball", { build({ outDir }) { return void Bun.write(outDir + "/service.tar.txt", "tarball"); } }); } });
`,
    });
    const built = await cli(["build", "--target", "zip"], root);
    expect(built.err).toEqual([]);
    expect(built.code).toBe(0);
    expect(built.out).toContain("zip: service.zip");
    expect(existsSync(join(root, "dist/zip/service.zip"))).toBe(true);
    expect(existsSync(join(root, "dist/zip/server.js"))).toBe(true);
    const tarball = await cli(["build", "--target", "tarball"], root);
    expect(tarball.err).toEqual([]);
    expect(tarball.code).toBe(0);
    expect(readFileSync(join(root, "dist/tarball/service.tar.txt"), "utf8")).toBe("tarball");
    const builtIn = await cli(["build"], project(config("deploy: { targets: { lambda: { build() {} } } }")));
    expect(builtIn.code).toBe(1);
    expect(builtIn.err).toEqual(["Deploy target lambda of the project conflicts with the built-in lambda target"]);
    const twice = await cli(["build"], project(config('deploy: { targets: { tarball: { build() {} } } }'), {
      "features/archive/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "archive", enabledByDefault: true, after: ["deploy"], setup(ctx) { ctx.feature("deploy").target("tarball", { build() {} }); } });
`,
    }));
    expect(twice.code).toBe(1);
    expect(twice.err).toEqual(["Deploy target tarball of the project conflicts with archive"]);
  }, 120_000);
});
