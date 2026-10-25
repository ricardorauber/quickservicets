import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boolean, defineFeature, list, object, oneOf, registerNative, registerProjectFeatures, string, toggle, type EntityModel } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "./build.ts";

const config = `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), guard: {} });
`;
const project = (files: Record<string, string>) => createLinkedProject({ "quickservice.config.ts": config, ...files });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const modelsOf = async (root: string) => (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
const entity = (name: string, tag: string) => `/** ${tag} */\nexport type ${name} = { a: string };\n`;

const rateLimit = (switchable: boolean) =>
  object({
    ...(switchable ? { enabled: boolean().default(true) } : {}),
    rate: string().default("100/min").describe("Requests per window."),
    by: oneOf(["ip", "user"]).default("ip").describe("What the limit counts."),
    channels: list(string()).default([]).describe("Where refusals are reported."),
  });
const guardFeature = (switchable = false) =>
  defineFeature({
    key: "guard",
    docs: { summary: "Guards routes." },
    options: object({ rateLimit: rateLimit(switchable), headers: string().default("strict").describe("Header policy.") }),
    tags: {
      limit: { on: ["entity", "endpoint"], scope: "rateLimit", shorthand: "rate", options: ["rate", "by"], description: "Limits one route.", example: "/** @limit 10/min */" },
      report: { on: ["entity"], scope: "rateLimit", shorthand: "channels", options: ["channels"], description: "Reports refusals.", example: "/** @report mail,sms */" },
    },
  });

let registered = false;
const register = (definition = guardFeature()) => {
  registerNative(definition);
  registered = true;
  return definition;
};
afterEach(() => {
  if (registered) unregisterNative("guard");
  registered = false;
  registerProjectFeatures([]);
});

describe("shorthand values", () => {
  test("a bare first value is the shorthand option, stored like its key=value form, and off still stores on: false", async () => {
    register();
    const root = project({
      "entities/Short.ts": entity("Short", "@limit 10/min by=user"),
      "entities/Long.ts": entity("Long", "@limit rate=10/min by=user"),
      "entities/Off.ts": entity("Off", "@limit off"),
    });
    await build(root);
    const models = await modelsOf(root);
    const tagsOf = (key: string) => models.find((model) => model.key === key)!.tags;
    expect(tagsOf("Short")).toEqual({ limit: { on: true, options: { rate: "10/min", by: "user" } } });
    expect(tagsOf("Long")).toEqual(tagsOf("Short")!);
    expect(tagsOf("Off")).toEqual({ limit: { on: false, options: {} } });
  });

  test("a shorthand given twice fails, a quoted shorthand is one text, and a list shorthand splits on commas", async () => {
    register();
    const twice = project({ "entities/Post.ts": entity("Post", "@limit 10/min rate=5/min") });
    expect((await failure(() => build(twice))).message).toBe("entities/Post.ts: invalid @limit: rate is given twice");
    const root = project({ "entities/Quoted.ts": entity("Quoted", '@limit "a b"'), "entities/Listed.ts": entity("Listed", "@report a,b") });
    await build(root);
    const models = await modelsOf(root);
    expect(models.find((model) => model.key === "Quoted")!.tags).toEqual({ limit: { on: true, options: { rate: "a b" } } });
    expect(models.find((model) => model.key === "Listed")!.tags).toEqual({ report: { on: true, options: { channels: ["a", "b"] } } });
  });
});

describe("scoped options", () => {
  test("values are validated with the nested option's schema", async () => {
    register();
    const root = project({ "entities/Post.ts": entity("Post", "@limit by=everyone") });
    expect((await failure(() => build(root))).message).toBe('entities/Post.ts: invalid @limit: by: expected one of "ip", "user", got "everyone"');
    const unknown = project({ "entities/Post.ts": entity("Post", "@limit headers=loose") });
    expect((await failure(() => build(unknown))).message).toBe("entities/Post.ts: invalid @limit: unknown option headers");
  });
});

describe("definition errors", () => {
  test("a scope that is not an object, an option outside the scope and a shorthand outside the options throw", () => {
    const options = object({ rateLimit: object({ rate: string().default("1/s"), by: string().default("ip") }), headers: string().default("x") });
    const define = (tag: Record<string, unknown>) => () =>
      defineFeature({ docs: { summary: "Test native." }, key: "guard", options, tags: { limit: { on: ["entity"], description: "d", example: "e", ...tag } } });
    expect(define({ scope: "nope", options: ["rate"] })).toThrow("Invalid tag @limit of guard: scope nope is not an object of the options");
    expect(define({ scope: "headers", options: ["rate"] })).toThrow("Invalid tag @limit of guard: scope headers is not an object of the options");
    expect(define({ scope: "rateLimit", options: ["rate", "burst"] })).toThrow("Invalid tag @limit of guard: burst is not an option of rateLimit");
    expect(define({ scope: "rateLimit", options: ["rate", "by"], shorthand: "by2" })).toThrow("Invalid tag @limit of guard: shorthand by2 is not one of its options");
    expect(define({ options: ["headers"], shorthand: "rate" })).toThrow("Invalid tag @limit of guard: shorthand rate is not one of its options");
  });
});

describe("optionsFor", () => {
  test("scoped values merge into the nested object only, over config and environment values", async () => {
    const guard = register();
    const root = project({ "endpoints/stats/get.ts": "/** @limit by=user */\nexport default () => 1;\n", "entities/Post.ts": entity("Post", "@limit 5/s") });
    await build(root);
    await serveBuilt(root, { QS_GUARD_RATE_LIMIT_RATE: "50/min", QS_GUARD_HEADERS: "loose" });
    const target = guard.optionsFor({ method: "GET", path: "/stats" });
    expect(target.rateLimit).toEqual({ rate: "50/min", by: "user", channels: [] });
    expect(target.headers).toBe("loose");
    expect(target.on).toBe(true);
    expect(guard.optionsFor("Post").rateLimit).toEqual({ rate: "5/s", by: "ip", channels: [] });
    expect(guard.options().rateLimit.by).toBe("ip");
  });

  test("off sets on: false, and enabled: false on a switchable scope for that target only", async () => {
    const guard = register(guardFeature(true));
    const root = project({ "entities/Off.ts": entity("Off", "@limit off"), "entities/On.ts": entity("On", "@limit 1/s") });
    await build(root);
    await serveBuilt(root);
    const off = guard.optionsFor("Off") as { on: boolean | undefined; rateLimit: { enabled: boolean; rate: string } };
    expect(off.on).toBe(false);
    expect(off.rateLimit).toMatchObject({ enabled: false, rate: "100/min" });
    expect((guard.optionsFor("On") as unknown as { rateLimit: { enabled: boolean } }).rateLimit.enabled).toBe(true);
    expect((guard.options() as unknown as { rateLimit: { enabled: boolean } }).rateLimit.enabled).toBe(true);
  });
});

describe("toggle scopes", () => {
  test("a tag scoped to a toggle sets its keys, and off turns the toggle off, for its target only", async () => {
    const guard = registerNative(
      defineFeature({ docs: { summary: "Test native." },
        key: "guard",
        options: object({ cors: toggle({ origins: list(string()).default([]) }) }),
        tags: { cors: { on: ["endpoint"], scope: "cors", shorthand: "origins", options: ["origins"], description: "Sets CORS.", example: "/** @cors https://a.dev */" } },
      }),
    );
    registered = true;
    const root = project({
      "endpoints/open/get.ts": "/** @cors https://a.dev,https://b.dev */\nexport default () => 1;\n",
      "endpoints/closed/get.ts": "/** @cors off */\nexport default () => 1;\n",
    });
    await build(root);
    await serveBuilt(root);
    expect(guard.optionsFor({ method: "GET", path: "/open" }).cors).toEqual({ enabled: true, origins: ["https://a.dev", "https://b.dev"] });
    expect(guard.optionsFor({ method: "GET", path: "/closed" }).cors).toEqual({ enabled: false, origins: [] });
    expect(guard.options().cors).toEqual({ enabled: true, origins: [] });
  });
});
