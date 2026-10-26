import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (flags: string | undefined, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), signin: {}, events: {}, history: {}, queues: { pollInterval: "1s" }${flags === undefined ? "" : `, flags: ${flags}`}${extra ? `, ${extra}` : ""} });
`;
/** A project feature that signs requests in as the user of x-user, before the flags are read. */
const SIGN_IN = `import { defineFeature } from "@quickservice/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", order: -60000, run: (req, _res, next) => { const user = req.headers.get("x-user"); if (user) (req as { user?: unknown }).user = { id: user }; return next(); } }],
});
`;
const RULES = '{ rules: { "checkout-v2": { users: ["u1"] }, coupons: { users: ["u1"] }, beta: { users: ["u1"] }, "dark-mode": true } }';
const FILES = {
  "quickservice.config.ts": config(RULES),
  "features/signin/index.ts": SIGN_IN,
  "endpoints/checkout/post.ts": `/**
 * @flag checkout-v2
 * @counted
 */
export default () => ({ ordered: true });
`,
  "hooks/counted.ts": 'import { definePreHook } from "@quickservice/core";\nexport default definePreHook(() => { (globalThis as any).hookRuns = ((globalThis as any).hookRuns ?? 0) + 1; });\n',
  "endpoints/status/get.ts": "/** @flag off */\nexport default () => ({ up: true });\n",
  "endpoints/open/get.ts": "export default () => ({ open: true });\n",
  "entities/Coupon.ts": "/**\n * @flag coupons\n * @history\n */\nexport type Coupon = { code: string };\n",
};
const post = (body: unknown, user?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: JSON.stringify(body) });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("gates", () => {
  test("an endpoint behind a flag answers 404 Route not found without running its pre-hooks, and runs for a user the rule turns on", async () => {
    const service = await startTestService({ files: FILES });
    try {
      (globalThis as { hookRuns?: number }).hookRuns = 0;
      const hidden = await service.fetch("/checkout", post({}, "u2"));
      expect([hidden.status, ((await hidden.json()) as { error: { code: string; message: string } }).error]).toEqual([404, { code: "NOT_FOUND", message: "Route not found" }]);
      expect((globalThis as { hookRuns?: number }).hookRuns).toBe(0);
      const shown = await service.fetch("/checkout", post({}, "u1"));
      expect([shown.status, await shown.json(), (globalThis as { hookRuns?: number }).hookRuns]).toEqual([200, { ordered: true }, 1]);
    } finally {
      await service.stop();
    }
  });

  test("an entity behind a flag hides its list, read, create and history routes", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const created = await service.fetch("/coupons", post({ code: "A" }, "u1"));
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      for (const [path, init] of [["/coupons", {}], [`/coupons/${id}`, {}], [`/coupons/${id}/history`, {}], ["/coupons", post({ code: "B" }, "u2")]] as const) {
        const headers = "headers" in init ? init.headers : { "x-user": "u2" };
        expect((await service.fetch(path, { ...init, headers })).status).toBe(404);
      }
      expect((await service.fetch(`/coupons/${id}/history`, { headers: { "x-user": "u1" } })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test("a global gate hides every route from u2, except an endpoint tagged @flag off", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservice.config.ts": config(RULES.replace("{ rules:", '{ gate: "beta", rules:')) } });
    try {
      expect((await service.fetch("/open", { headers: { "x-user": "u2" } })).status).toBe(404);
      expect((await service.fetch("/open", { headers: { "x-user": "u1" } })).status).toBe(200);
      expect((await service.fetch("/status", { headers: { "x-user": "u2" } })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});

describe("build checks and OpenAPI", () => {
  test("an unknown flag fails the build with a suggestion; with the database source any name builds", async () => {
    const files = { ...FILES, "endpoints/checkout/post.ts": "/** @flag checkout-v3 */\nexport default () => ({});\n" };
    expect((await failure(() => build(createLinkedProject(files)))).message).toContain("endpoints/checkout/post.ts: invalid @flag: unknown flag checkout-v3 (did you mean checkout-v2?)");
    await build(createLinkedProject({ ...files, "quickservice.config.ts": config('{ source: "database" }') }));
  });

  test("gated operations carry x-feature-flag", async () => {
    const root = createLinkedProject(FILES);
    await build(root);
    const document = JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8"));
    expect(document.paths["/checkout"].post["x-feature-flag"]).toBe("checkout-v2");
    expect(document.paths["/coupons"].get["x-feature-flag"]).toBe("coupons");
    expect(document.paths["/coupons/{id}/history"].get["x-feature-flag"]).toBe("coupons");
    expect(document.paths["/open"].get["x-feature-flag"]).toBeUndefined();
  });
});

describe("flags in jobs and queue consumers", () => {
  const JOB = 'import { job } from "@quickservice/core";\nexport default job("@daily", (ctx) => ({ checkout: ctx.flags.on("checkout-v2", { user: { id: "u1" } }), anonymous: ctx.flags.on("checkout-v2") }));\n';
  const QUEUE = 'import { queue } from "@quickservice/core";\nexport default queue((ctx) => { (globalThis as any).queueDarkMode = ctx.flags.on("dark-mode"); });\n';
  const ENDPOINTS = {
    "endpoints/run/post.ts": 'import type { Repositories, ServiceRequest } from "@quickservice/core";\nexport default (_repos: Repositories, req: ServiceRequest) => req.jobs.run("report");\n',
    "endpoints/enqueue/post.ts": 'import type { Repositories, ServiceRequest } from "@quickservice/core";\nexport default (_repos: Repositories, req: ServiceRequest) => req.queue.add("notify", {});\n',
  };

  test("a job reads ctx.flags for a user it passes, and a queue consumer gets the rule's value", async () => {
    const service = await startTestService({ files: { ...FILES, ...ENDPOINTS, "jobs/report.ts": JOB, "queues/notify.ts": QUEUE } });
    try {
      const { runId } = (await (await service.fetch("/run", post({}))).json()) as { runId: string };
      await service.fetch("/enqueue", post({}));
      type Run = { id: string; status: string; result?: unknown };
      const runs = (service.repos as unknown as { jobRuns: { findById(id: string): Promise<Run | null> } }).jobRuns;
      for (let tries = 0; tries < 300 && ((await runs.findById(runId))?.status !== "success" || (globalThis as { queueDarkMode?: boolean }).queueDarkMode === undefined); tries++) await Bun.sleep(10);
      expect((await runs.findById(runId))!.result).toEqual({ checkout: true, anonymous: false });
      expect((globalThis as { queueDarkMode?: boolean }).queueDarkMode).toBe(true);
    } finally {
      await service.stop();
    }
  });

  test("without flags, ctx.flags is a type error", async () => {
    const root = createLinkedProject({ "features/signin/index.ts": SIGN_IN, "quickservice.config.ts": config(undefined) });
    await build(root);
    const check = join(root, "check.ts");
    writeFileSync(check, 'import { job } from "@quickservice/core";\nexport default job("@daily", (ctx) => ctx.flags.on("x"));\n');
    const program = ts.createProgram([check], { strict: true, noEmit: true, skipLibCheck: true, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true });
    const errors = ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    expect(errors.some((error) => error.includes("flags"))).toBe(true);
  });
});
