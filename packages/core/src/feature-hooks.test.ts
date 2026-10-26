import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import * as featureHooks from "./feature-hooks.ts";
import { runAfterHooks, runBeforeHooks } from "./feature-hooks.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { describeOptions, hook, object, resolveOptions, string, type FeatureHook, type Options } from "./options.ts";

interface Write {
  n: number;
}

interface AuditApi {
  addHook(name: "beforeWrite", fn: FeatureHook<Write, { by: string }>): void;
  write(value: Write): Promise<Write>;
}

declare module "./features.ts" {
  interface FeatureApis {
    audit: AuditApi;
  }
}

const auditOptions = object({ label: string().default("audit").describe("A label."), beforeWrite: hook<Write, { by: string }>().describe("Runs before each write.") });

/** A step guarded by the feature's before-hooks, skipping them when none is configured or added. */
const write = async (options: Options<typeof auditOptions>, value: Write) =>
  options.beforeWrite.length === 0 ? value : featureHooks.runBeforeHooks(options.beforeWrite, value, { by: "test" });

const audit = defineFeature({
  key: "audit",
  docs: { summary: "Audits writes." },
  options: auditOptions,
  api: (ctx) => ({ addHook: ctx.addHook, write: (value: Write) => write(ctx.options, value) }),
});

const failure = async (run: () => unknown): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

const registered: string[] = [];
const register = (...definitions: Parameters<typeof registerNative>[0][]) => {
  for (const definition of definitions) {
    registerNative(definition);
    registered.push(definition.key);
  }
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});

const entries: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };

const lifecycleOf = (config: Record<string, unknown>) => {
  const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, {});
  return createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
};

describe("hook()", () => {
  test("resolves to a list, takes one function or a list, and rejects other values", () => {
    const one = () => undefined;
    const two = () => undefined;
    expect(resolveOptions(auditOptions, {}, "audit").beforeWrite).toEqual([]);
    expect(resolveOptions(auditOptions, { beforeWrite: one }, "audit").beforeWrite).toEqual([one]);
    expect(resolveOptions(auditOptions, { beforeWrite: [one, two] }, "audit").beforeWrite).toEqual([one, two]);
    expect(() => resolveOptions(auditOptions, { beforeWrite: "x" as never }, "audit")).toThrow('Invalid audit.beforeWrite: expected a function or a list of functions, got "x"');
    expect(() => resolveOptions(auditOptions, { beforeWrite: [one, 1] as never }, "audit")).toThrow("expected a function or a list of functions");
  });

  test("is described with type hook and has no environment variable", () => {
    expect(describeOptions(audit.schema, "audit").find((option) => option.path === "audit.beforeWrite")).toMatchObject({ type: "hook" });
    const resolved = resolveConfig({ database: memoryAdapter(), logger, audit: {} } as ServiceConfig, { QS_AUDIT_BEFORE_WRITE: "x" }, process.cwd());
    expect(resolved.warnings).toEqual(["Unknown environment variable QS_AUDIT_BEFORE_WRITE"]);
  });
});

describe("runBeforeHooks", () => {
  test("passes on returned values and keeps the value when a hook returns undefined", async () => {
    const hooks: FeatureHook<Write, null>[] = [(value) => ({ n: value.n + 1 }), () => undefined];
    expect(await runBeforeHooks(hooks, { n: 1 }, null)).toEqual({ n: 2 });
  });

  test("rejects with a throwing hook's error, and later hooks do not run", async () => {
    let later = false;
    const hooks: FeatureHook<Write, null>[] = [
      () => {
        throw new Error("vetoed");
      },
      () => {
        later = true;
      },
    ];
    expect((await failure(() => runBeforeHooks(hooks, { n: 1 }, null))).message).toBe("vetoed");
    expect(later).toBe(false);
  });
});

describe("runAfterHooks", () => {
  test("logs a failing hook with the feature and hook names, and runs the next one", async () => {
    entries.length = 0;
    const seen: number[] = [];
    const options = resolveOptions(object({ afterWrite: hook<Write>() }), {
      afterWrite: [
        () => {
          throw new Error("broken");
        },
        (value: Write) => void seen.push(value.n),
      ],
    }, "audit");
    resolveConfig({ database: memoryAdapter(), logger } as ServiceConfig, {});
    await runAfterHooks(options.afterWrite, { n: 7 }, undefined);
    expect(seen).toEqual([7]);
    expect(entries).toContainEqual(expect.objectContaining({ message: "feature.hook.failed", feature: "audit", hook: "afterWrite", error: expect.objectContaining({ message: "broken" }) }));
  });
});

describe("hook names", () => {
  test("hook options must be named before<Step>, after<Step> or on<Event>", () => {
    expect(() => registerNative(defineFeature({ key: "audit", docs: { summary: "s" }, options: object({ writeHook: hook() }) }))).toThrow(
      "Invalid feature audit: hook option writeHook must be named before<Step>, after<Step> or on<Event>",
    );
    expect(() => defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ nested: object({ hooked: hook() }) }) })).toThrow("hook option nested.hooked");
    expect(() => defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ beforeWrite: hook(), afterWrite: hook(), onFailure: hook() }) })).not.toThrow();
  });
});

describe("feature APIs", () => {
  test("a feature adds a hook through another feature's API, run after the config's hooks", async () => {
    const order: string[] = [];
    const b = defineFeature({ docs: { summary: "Test native." },
      key: "b",
      requires: ["audit"],
      setup(ctx) {
        // Typed through FeatureApis: no cast.
        const api = ctx.feature("audit");
        api.addHook("beforeWrite", (value) => {
          order.push("b");
          return { n: value.n * 10 };
        });
      },
    });
    register(audit, b);
    const lifecycle = lifecycleOf({
      audit: {
        beforeWrite: (value: Write) => {
          order.push("config");
          return { n: value.n + 1 };
        },
      },
      b: {},
    });
    await lifecycle.setup();
    expect(await write(audit.options(), { n: 1 })).toEqual({ n: 20 });
    expect(order).toEqual(["config", "b"]);
  });

  test("a disabled feature, an unlisted feature and an unknown hook throw", async () => {
    const after = defineFeature({ docs: { summary: "Test native." }, key: "b", after: ["audit"], setup: (ctx) => void ctx.feature("audit") });
    register(audit, after);
    expect((await failure(() => lifecycleOf({ b: {} }).setup())).message).toBe("b failed in setup: b uses audit, which is not enabled; add audit: {} to quickservicets.config.ts");
    register(defineFeature({ docs: { summary: "Test native." }, key: "c", setup: (ctx) => void ctx.feature("audit") }));
    expect((await failure(() => lifecycleOf({ audit: {}, c: {} }).setup())).message).toBe("c failed in setup: c uses audit; add it to requires or after");
    register(defineFeature({ docs: { summary: "Test native." }, key: "d", requires: ["audit"], setup: (ctx) => ctx.feature("audit").addHook("nope" as never, () => undefined) }));
    expect((await failure(() => lifecycleOf({ audit: {}, d: {} }).setup())).message).toBe("d failed in setup: Unknown hook nope of audit");
  });
});

describe("the no-hook path", () => {
  test("a step with no hooks calls neither runner", async () => {
    register(audit);
    await lifecycleOf({ audit: {} }).setup();
    const before = spyOn(featureHooks, "runBeforeHooks");
    const afterSpy = spyOn(featureHooks, "runAfterHooks");
    try {
      expect(await write(audit.options(), { n: 3 })).toEqual({ n: 3 });
      expect(before).not.toHaveBeenCalled();
      expect(afterSpy).not.toHaveBeenCalled();
      audit.options().beforeWrite.push((value) => ({ n: value.n + 1 }));
      expect(await write(audit.options(), { n: 3 })).toEqual({ n: 4 });
      expect(before).toHaveBeenCalledTimes(1);
    } finally {
      before.mockRestore();
      afterSpy.mockRestore();
    }
  });
});
