import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).flagLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).flagLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).flagLogs ??= []).push(entry),
  }`;
const config = (flags: string, extra = "", adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}, signin: {}, flags: ${flags}, ${LOGGER}${extra ? `, ${extra}` : ""} });
`;
/** A project feature that signs requests in from the x-user and x-plan headers, before the flags are read. */
const SIGN_IN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", order: -60000, run: (req, _res, next) => {
    const user = req.headers.get("x-user");
    const plan = req.headers.get("x-plan");
    if (user) (req as { user?: unknown }).user = { id: user };
    if (plan) (req as { tenant?: unknown }).tenant = { id: "t1", plan };
    return next();
  } }],
});
`;
const FILES = {
  "features/signin/index.ts": SIGN_IN,
  "endpoints/flags/get.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default (_repos: unknown, req: ServiceRequest) => {
  const names = (req.query.get("names") ?? "").split(",").filter(Boolean);
  return { values: names.map((name) => req.flags!.on(name as never)), again: names.map((name) => req.flags!.on(name as never)), all: req.flags!.all() };
};
`,
};
type Answer = { values: boolean[]; all: Record<string, boolean> };
const read = async (service: { fetch(path: string, init?: RequestInit): Promise<Response> }, names: string, headers: Record<string, string> = {}) => {
  const response = await service.fetch(`/flags?names=${names}`, { headers });
  return { status: response.status, body: (await response.json()) as Answer };
};
const logs = () => ((globalThis as { flagLogs?: Record<string, unknown>[] }).flagLogs ??= []);
afterEach(() => {
  logs().length = 0;
});

describe("defaults and variables", () => {
  test("flags: {} works with every default, and the rule variables turn off, roll out and switch the source", async () => {
    const empty = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{}") } });
    try {
      expect((await read(empty, "")).body.all).toEqual({});
    } finally {
      await empty.stop();
    }
    const files = { ...FILES, "quickservicets.config.ts": config('{ rules: { "checkout-v2": true } }') };
    const off = await startTestService({ files, env: { QS_FLAGS_RULES_CHECKOUT_V2: "false" } });
    try {
      expect((await read(off, "checkout-v2")).body.values).toEqual([false]);
    } finally {
      await off.stop();
    }
    const rollout = await startTestService({ files, env: { QS_FLAGS_RULES_CHECKOUT_V2_PERCENTAGE: "25" } });
    try {
      const values = await Promise.all(Array.from({ length: 40 }, async (_, index) => (await read(rollout, "checkout-v2", { "x-user": `user-${index}` })).body.values[0]));
      expect(values.some((value) => value)).toBe(true);
      expect(values.some((value) => !value)).toBe(true);
    } finally {
      await rollout.stop();
    }
    const root = createLinkedProject(files);
    await build(root, { QS_FLAGS_SOURCE: "database" });
    const models = (await import(join(root, ".generated/models.ts"))).models as { key: string }[];
    expect(models.some((model) => model.key === "FeatureFlag")).toBe(true);
  });
});

describe("function rules", () => {
  const RULES = '{ rules: { "pro-reports": ({ tenant, req }) => { (globalThis as any).ruleCalls = ((globalThis as any).ruleCalls ?? 0) + 1; return (tenant as { plan?: string } | undefined)?.plan === "pro"; } } }';

  test("a function rule decides per request, once per name; a promise answers 500 with the message; a variable replaces the function", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(RULES) } });
    try {
      (globalThis as { ruleCalls?: number }).ruleCalls = 0;
      expect((await read(service, "pro-reports", { "x-plan": "pro" })).body.values).toEqual([true]);
      expect((globalThis as { ruleCalls?: number }).ruleCalls).toBe(1);
      expect((await read(service, "pro-reports", { "x-plan": "free" })).body.values).toEqual([false]);
    } finally {
      await service.stop();
    }
    const promised = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ rules: { async: () => Promise.resolve(true) } }") } });
    try {
      expect((await read(promised, "async")).status).toBe(500);
      expect(logs().some((entry) => JSON.stringify(entry).includes("Invalid flags.rules.async: expected a boolean returned synchronously"))).toBe(true);
    } finally {
      await promised.stop();
    }
    const replaced = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(RULES) }, env: { QS_FLAGS_RULES_PRO_REPORTS: "true" } });
    try {
      expect((await read(replaced, "pro-reports", { "x-plan": "free" })).body.values).toEqual([true]);
    } finally {
      await replaced.stop();
    }
  });
});

describe("onEvaluate", () => {
  test("records each new evaluation once per request with its reason; a throwing hook is logged and the request succeeds", async () => {
    const hook = '{ rules: { "checkout-v2": { users: ["u1"] } }, onEvaluate: [(evaluation) => void ((globalThis as any).evaluations ??= []).push({ name: evaluation.name, on: evaluation.on, reason: evaluation.reason }), () => { throw new Error("hook broke"); }] }';
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(hook) } });
    try {
      (globalThis as { evaluations?: unknown[] }).evaluations = [];
      const answer = await read(service, "checkout-v2", { "x-user": "u1" });
      expect(answer.status).toBe(200);
      await Bun.sleep(5);
      expect((globalThis as { evaluations?: unknown[] }).evaluations).toEqual([{ name: "checkout-v2", on: true, reason: "user" }]);
      expect(logs().some((entry) => entry.message === "feature.hook.failed" && entry.hook === "onEvaluate")).toBe(true);
    } finally {
      await service.stop();
    }
  });
});

describe("providers", () => {
  const PROVIDER = `export const events: string[] = ((globalThis as any).providerEvents = []);
export const betaOnly = {
  isOn: (name: string) => name === "beta",
  all: () => ({ beta: true }),
  start: () => void events.push("start"),
  stop: () => void events.push("stop"),
};
`;
  test("a config provider answers instead of the rules and starts and stops with the server", async () => {
    const files = {
      ...FILES,
      "provider.ts": PROVIDER,
      "quickservicets.config.ts": config('{ rules: { "checkout-v2": true }, provider: betaOnly }').replace('import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";', 'import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";\nimport { betaOnly } from "./provider.ts";'),
    };
    const service = await startTestService({ files });
    try {
      const answer = await read(service, "beta,checkout-v2");
      expect([answer.body.values, answer.body.all]).toEqual([[true, false], { beta: true }]);
      expect((globalThis as { providerEvents?: string[] }).providerEvents).toEqual(["start"]);
    } finally {
      await service.stop();
    }
    expect((globalThis as { providerEvents?: string[] }).providerEvents).toEqual(["start", "stop"]);
  });

  test("two features setting providers fail startup", async () => {
    const feature = (key: string) => `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "${key}", requires: ["flags"], setup(ctx) { ctx.feature("flags").setProvider({ isOn: () => true, all: () => ({}) }); } });
`;
    const files = { ...FILES, "features/one/index.ts": feature("one"), "features/two/index.ts": feature("two"), "quickservicets.config.ts": config("{}", "one: {}, two: {}") };
    await expect(startTestService({ files })).rejects.toThrow("Flag provider set by one and two; keep one");
  });
});

describe("the FeatureFlag entity", () => {
  test("a project entity with an extra field builds and migrates; one without percentage fails", async () => {
    const entity = (fields: string) => `/** @internal */\nexport type FeatureFlag = {\n${fields}\n};\n`;
    const all = '  /** @unique */\n  name: string;\n  /** @default true */\n  enabled: boolean;\n  users?: string[];\n  tenants?: string[];\n  percentage?: number;\n  description?: string;';
    const root = createLinkedProject({ ...FILES, "quickservicets.config.ts": config('{ source: "database" }', "", 'sqliteAdapter({ path: ":memory:" })'), "entities/FeatureFlag.ts": entity(`${all}\n  owner?: string;`) });
    const migration = readFileSync(join(root, (await addMigration(root, "Flags", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(migration).toContain("owner");
    const missing = createLinkedProject({ ...FILES, "quickservicets.config.ts": config('{ source: "database" }'), "entities/FeatureFlag.ts": entity(all.replace("  percentage?: number;\n", "")) });
    await expect(build(missing)).rejects.toThrow("entities/FeatureFlag.ts: FeatureFlag needs the field percentage (number) used by flags");
  });
});

describe("the reference page", () => {
  test("lists the per-rule variables, the tag, onEvaluate and FlagProvider", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/flags.mdx"), "utf8");
    for (const text of ["QS_FLAGS_RULES_<NAME>", "### `@flag`", "`flags.onEvaluate`", "FlagProvider", "flags set"]) expect(page).toContain(text);
  });
});
