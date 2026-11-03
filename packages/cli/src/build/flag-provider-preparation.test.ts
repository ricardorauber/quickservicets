import { afterEach, describe, expect, test } from "bun:test";
import { flags, registerProjectFeatures } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const state = globalThis as unknown as { prepares: string[]; prepared: Record<string, boolean> | "never"; logs: { message: string; flag?: string }[]; jobResult?: unknown };

/** A provider whose SDK answers asynchronously: `prepare` resolves the values, `isOn` reads them. */
const PROVIDER = `import { defineFeature } from "@quickservicets/core";
const state = globalThis as unknown as { prepares: string[]; prepared: Record<string, boolean> | "never" };
export default defineFeature({
  key: "remote-flags",
  requires: ["flags"],
  setup(ctx) {
    ctx.feature("flags").setProvider({
      async prepare({ user }) {
        state.prepares.push(String((user as { id?: string } | undefined)?.id ?? "-"));
        if (state.prepared === "never") return new Promise(() => {});
        await Bun.sleep(5);
        return state.prepared;
      },
      isOn: (name, { prepared }) => prepared?.[name] === true,
      all: ({ prepared }) => ({ ...(prepared ?? {}) }),
    });
  },
});
`;
const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info: (entry) => globalThis.logs?.push(entry), warn: (entry) => globalThis.logs?.push(entry), error() {} }, flags: { rules: { "checkout-v2": false }, ${keys} }, "remote-flags": {} });
`;
const FILES = {
  "features/remote-flags/index.ts": PROVIDER,
  "endpoints/settings/get.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default (_repos: unknown, req: ServiceRequest) => ({ a: req.flags.on("checkout-v2"), b: req.flags.on("checkout-v2"), c: req.flags.on("other"), all: req.flags.all() });
`,
  "endpoints/checkout/post.ts": "/** @flag checkout-v2 */\nexport default () => ({ ok: true });\n",
  "jobs/check.ts": `import { job } from "@quickservicets/core";
export default job({ every: "1h" }, async (ctx) => {
  const evaluated = await ctx.flags.evaluate("checkout-v2", { user: { id: "u1" } });
  const synchronous = ctx.flags.on("checkout-v2");
  ctx.flags.on("checkout-v2");
  (globalThis as unknown as { jobResult: unknown }).jobResult = { evaluated, synchronous };
});
`,
  "endpoints/run-check/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.jobs.run("check");
`,
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(keys = "", env: Record<string, string> = {}, files: Record<string, string> = FILES) {
  state.prepares = [];
  state.prepared = { "checkout-v2": true };
  state.logs = [];
  state.jobResult = undefined;
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...files }, env });
  running.push(service);
  return service;
}

describe("preparing a request", () => {
  test("prepare runs once per request and the handler reads its values synchronously", async () => {
    const service = await start();
    const body = (await (await service.fetch("/settings")).json()) as Record<string, unknown>;
    expect(body).toEqual({ a: true, b: true, c: false, all: { "checkout-v2": true } });
    expect(state.prepares).toHaveLength(1);
  });

  test("a route gated by @flag answers 200 when the prepared value is on and 404 when it is off", async () => {
    const service = await start();
    expect((await service.fetch("/checkout", { method: "POST" })).status).toBe(200);
    state.prepared = {};
    expect((await service.fetch("/checkout", { method: "POST" })).status).toBe(404);
  });

  test("a prepare that never resolves is cut at prepareTimeout, the flag is off and the failure is logged once", async () => {
    const service = await start();
    state.prepared = "never";
    const started = Date.now();
    expect(await (await service.fetch("/settings")).json()).toMatchObject({ a: false });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(1000);
    await service.fetch("/settings");
    expect(state.logs.filter((entry) => entry.message === "flags.prepare.failed")).toHaveLength(1);
  });

  test("QS_FLAGS_PREPARE_TIMEOUT=1s changes the bound", async () => {
    const service = await start("", { QS_FLAGS_PREPARE_TIMEOUT: "1s" });
    state.prepared = "never";
    const started = Date.now();
    await service.fetch("/settings");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });
});

describe("outside requests", () => {
  test("ctx.flags.evaluate prepares for the user it names; a synchronous on warns once per flag", async () => {
    const service = await start();
    expect((await service.fetch("/run-check", { method: "POST" })).status).toBeLessThan(300);
    for (let index = 0; index < 100 && state.jobResult === undefined; index++) await Bun.sleep(10);
    expect(state.jobResult).toEqual({ evaluated: true, synchronous: false });
    expect(state.prepares).toContain("u1");
    expect(state.logs.filter((entry) => entry.message === "flags.provider.unprepared" && entry.flag === "checkout-v2")).toHaveLength(1);
    expect(await flags.evaluate("checkout-v2", { user: { id: "u2" } })).toBe(true);
  });

  test("with the config source nothing prepares, and flags.evaluate resolves what req.flags.on answers", async () => {
    const { "features/remote-flags/index.ts": _provider, ...files } = FILES;
    state.prepares = [];
    const service = await startTestService({
      files: {
        ...files,
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), flags: { rules: { "checkout-v2": { users: ["u1"] } } } });\n`,
        "endpoints/settings/get.ts": `import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => ({ a: req.flags.on("checkout-v2") });\n`,
      },
    });
    running.push(service);
    expect(await (await service.fetch("/settings")).json()).toEqual({ a: false });
    expect(await flags.evaluate("checkout-v2", { user: { id: "u1" } })).toBe(true);
    expect(await flags.evaluate("checkout-v2", { user: { id: "u2" } })).toBe(false);
    expect(state.prepares).toEqual([]);
  });
});
