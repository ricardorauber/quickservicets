import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineFeature, duration, list, object, registerNative, registerProjectFeatures, string, type EntityModel } from "@quickservicets/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "./build.ts";

const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const project = (files: Record<string, string>, keys = "audit: {}") => createLinkedProject({ "quickservicets.config.ts": config(keys), ...files });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const modelsOf = async (root: string) => (await import(join(root, ".generated/models.ts"))).models as EntityModel[];

const tag = { on: ["entity", "endpoint"] as const, options: ["greeting", "retention", "channels"], description: "Audits writes.", example: '/** @audit greeting="Good day" */' };
const audit = defineFeature({ docs: { summary: "Test native." },
  key: "audit",
  options: object({ greeting: string().default("Hello"), retention: duration().default("30d"), channels: list(string()).default(["log"]) }),
  tags: { audit: tag },
});
let registered = false;
const register = (definition = audit) => {
  registerNative(definition);
  registered = true;
};
afterEach(() => {
  if (registered) unregisterNative("audit");
  registered = false;
  registerProjectFeatures([]);
});

const POST = '/** @audit greeting="Good day" */\nexport type Post = { title: string };\n';
const COMMENT = "/** @audit off */\nexport type Comment = { body: string };\n";

describe("registration and targets", () => {
  test("an enabled feature's tag on an entity is stored on the model", async () => {
    register();
    const root = project({ "entities/Post.ts": POST, "entities/Comment.ts": COMMENT, "entities/Plain.ts": "export type Plain = { a: string };\n" });
    await build(root);
    const models = await modelsOf(root);
    expect(models.find((model) => model.key === "Post")!.tags).toEqual({ audit: { on: true, options: { greeting: "Good day" } } });
    expect(models.find((model) => model.key === "Comment")!.tags).toEqual({ audit: { on: false, options: {} } });
    expect("tags" in models.find((model) => model.key === "Plain")!).toBe(false);
  });

  test("a tag on a target it does not list fails", async () => {
    register();
    const root = project({ "entities/Post.ts": "export type Post = {\n  /** @audit */\n  title: string;\n};\n" });
    expect((await failure(() => build(root))).message).toBe("entities/Post.ts: invalid @audit: applies only to entities and endpoints, not to fields");
  });

  test("field and endpoint tags are stored on the field and the generated endpoint entry", async () => {
    register(defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ greeting: string().default("Hello") }), tags: { audit: { ...tag, on: ["field", "endpoint"], options: ["greeting"] } } }));
    const root = project({
      "entities/Post.ts": 'export type Post = {\n  /** @audit greeting=Hey */\n  title: string;\n};\n',
      "endpoints/stats/get.ts": "/** @audit off */\nexport default () => ({ ok: true });\n",
    });
    await build(root);
    expect((await modelsOf(root)).find((model) => model.key === "Post")!.fields[0]!.tags).toEqual({ audit: { on: true, options: { greeting: "Hey" } } });
    const { endpoints } = await import(join(root, ".generated/routes.ts"));
    expect(endpoints[0].tags).toEqual({ audit: { on: false, options: {} } });
  });
});

describe("syntax", () => {
  test("flags, off, quoted values with escapes and comma-separated lists", async () => {
    register();
    const root = project({
      "entities/Flag.ts": "/** @audit */\nexport type Flag = { a: string };\n",
      "entities/Quoted.ts": '/** @audit greeting="Say \\"hi\\" now" channels=mail,sms retention=7d */\nexport type Quoted = { a: string };\n',
    });
    await build(root);
    const models = await modelsOf(root);
    expect(models.find((model) => model.key === "Flag")!.tags).toEqual({ audit: { on: true, options: {} } });
    expect(models.find((model) => model.key === "Quoted")!.tags).toEqual({ audit: { on: true, options: { greeting: 'Say "hi" now', channels: ["mail", "sms"], retention: "7d" } } });
  });

  test("text that is not key=value pairs fails", async () => {
    register();
    const root = project({ "entities/Post.ts": "/** @audit loudly */\nexport type Post = { a: string };\n" });
    expect((await failure(() => build(root))).message).toBe('entities/Post.ts: invalid @audit: expects off or key=value pairs, got "loudly"');
  });
});

describe("option validation", () => {
  test("unknown options suggest the right name and invalid values fail", async () => {
    register();
    const typo = project({ "entities/Post.ts": "/** @audit greting=Hi */\nexport type Post = { a: string };\n" });
    expect((await failure(() => build(typo))).message).toBe("entities/Post.ts: invalid @audit: unknown option greting (did you mean greeting?)");
    const invalid = project({ "entities/Post.ts": "/** @audit retention=soon */\nexport type Post = { a: string };\n" });
    expect((await failure(() => build(invalid))).message).toBe(
      'entities/Post.ts: invalid @audit: retention: expected a duration like 30s, 10m or 30d (units ms, s, m, h, d), got "soon"',
    );
  });

  test("a flag tag takes no options, and definitions may only list the feature's options", async () => {
    register(defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ greeting: string().default("Hello") }), tags: { audit: { on: ["entity"], description: "d", example: "e" } } }));
    const root = project({ "entities/Post.ts": "/** @audit greeting=Hi */\nexport type Post = { a: string };\n" });
    expect((await failure(() => build(root))).message).toBe("entities/Post.ts: invalid @audit: takes no options, got greeting");
    expect(() => defineFeature({ docs: { summary: "Test native." }, key: "other", tags: { other: { on: ["entity"], options: ["nope"], description: "d", example: "e" } } })).toThrow(
      "Invalid feature other: tag @other: nope is not an option of the feature",
    );
    expect(() => defineFeature({ docs: { summary: "Test native." }, key: "other", tags: { other: { on: ["table" as never], description: "d", example: "e" } } })).toThrow("on must list entity, field or endpoint");
  });
});

describe("conflicts and unknown tags", () => {
  test("a feature tag named like a built-in tag, a hook or another feature's tag fails naming both owners", async () => {
    register(defineFeature({ docs: { summary: "Test native." }, key: "audit", tags: { unique: { on: ["entity"], description: "d", example: "e" } } }));
    expect((await failure(() => build(project({ "entities/Post.ts": "export type Post = { a: string };\n" })))).message).toBe(
      "Tag @unique of audit conflicts with the built-in tag @unique",
    );
    unregisterNative("audit");
    register();
    const hook = 'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook(() => {});\n';
    expect((await failure(() => build(project({ "entities/Post.ts": "export type Post = { a: string };\n", "hooks/audit.ts": hook })))).message).toBe(
      "Tag @audit of audit conflicts with the hook hooks/audit.ts",
    );
    const other = `import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "other", tags: { audit: { on: ["entity"], description: "d", example: "e" } } });\n`;
    expect((await failure(() => build(project({ "features/other/index.ts": other }, "audit: {}, other: {}")))).message).toBe("Tag @audit of other conflicts with audit");
  });

  test("a disabled native's tag asks for the native, and an unknown tag says nothing defines it", async () => {
    register();
    const disabled = project({ "entities/Post.ts": POST }, "");
    expect((await failure(() => build(disabled))).message).toBe("entities/Post.ts: @audit needs audit, which is not enabled; add audit: {} to quickservicets.config.ts");
    const endpoint = project({ "endpoints/stats/get.ts": "/** @audit off */\nexport default () => 1;\n" }, "");
    expect((await failure(() => build(endpoint))).message).toBe("endpoints/stats/get.ts: @audit needs audit, which is not enabled; add audit: {} to quickservicets.config.ts");
    const unknown = project({ "entities/Post.ts": "/** @nope */\nexport type Post = { a: string };\n" });
    expect((await failure(() => build(unknown))).message).toBe("entities/Post.ts: unknown tag @nope: no hook or feature defines it");
  });
});

describe("optionsFor", () => {
  test("tag options win over the config and environment for their target only", async () => {
    register();
    const root = project({
      "entities/Post.ts": POST,
      "entities/Comment.ts": COMMENT,
      "endpoints/stats/get.ts": "/** @audit greeting=Stats */\nexport default () => 1;\n",
    });
    await build(root);
    await serveBuilt(root);
    expect(audit.optionsFor("Post")).toMatchObject({ greeting: "Good day", retention: "30d", on: true });
    expect(audit.optionsFor("Comment")).toMatchObject({ greeting: "Hello", on: false });
    expect(audit.optionsFor({ method: "GET", path: "/stats" })).toMatchObject({ greeting: "Stats", on: true });
    expect(audit.optionsFor({ entity: "Post", field: "title" })).toMatchObject({ greeting: "Hello", on: undefined });
    const models = await modelsOf(root);
    expect(audit.optionsFor(models.find((model) => model.key === "Post")!).greeting).toBe("Good day");

    await serveBuilt(root, { QS_AUDIT_GREETING: "Howdy" });
    expect(audit.optionsFor("Comment").greeting).toBe("Howdy");
    expect(audit.optionsFor("Post").greeting).toBe("Good day");
  });
});
