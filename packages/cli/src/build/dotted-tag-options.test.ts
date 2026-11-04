import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boolean, defineFeature, duration, object, registerNative, registerProjectFeatures, string, type EntityModel } from "@quickservicets/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const example = defineFeature({
  docs: { summary: "Test native." },
  key: "example",
  options: object({ label: string().default("Records"), hidden: boolean().default(false), greeting: string().default("Hello"), retention: duration().default("30d") }),
  tags: { example: { on: ["entity", "field"], options: ["label", "hidden", "greeting", "retention"], description: "Labels an entity.", example: '/** @example label="Customer accounts" */' } },
});
beforeEach(() => registerNative(example));
afterEach(() => {
  unregisterNative("example");
  registerProjectFeatures([]);
});

const config = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), example: {} });
`;
const entity = (lines: string[]) => `/**\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\nexport type Account = { name: string };\n`;
const tagsOf = async (lines: string[]) => {
  const root = createLinkedProject({ "quickservicets.config.ts": config, "entities/Account.ts": entity(lines) });
  await build(root);
  const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
  return models.find((model) => model.key === "Account")!.tags;
};
const failure = async (lines: string[]) => {
  const root = createLinkedProject({ "quickservicets.config.ts": config, "entities/Account.ts": entity(lines) });
  return build(root).then(
    () => "built",
    (error: Error) => error.message,
  );
};

describe("dotted tag options", () => {
  test("a dotted line sets one option with the rest of its text, and a boolean needs no value", async () => {
    const dotted = await tagsOf(["@example.label Customer accounts", "@example.hidden"]);
    expect(dotted).toEqual({ example: { on: true, options: { label: "Customer accounts", hidden: true } } });
    expect(await tagsOf(['@example label="Customer accounts" hidden=true'])).toEqual(dotted!);
    expect(await tagsOf(["@example.retention 7d"])).toEqual({ example: { on: true, options: { retention: "7d" } } });
  }, 30_000);

  test("dotted lines merge with one plain line; off cannot be combined with them", async () => {
    expect(await tagsOf(["@example greeting=Hi", "@example.label X"])).toEqual({ example: { on: true, options: { greeting: "Hi", label: "X" } } });
    expect(await tagsOf(["@example.label X", "@example greeting=Hi"])).toEqual({ example: { on: true, options: { label: "X", greeting: "Hi" } } });
    expect(await failure(["@example off", "@example.label X"])).toBe("entities/Account.ts: @example off cannot be combined with @example.label");
    expect(await failure(["@example.label X", "@example off"])).toBe("entities/Account.ts: @example off cannot be combined with @example.label");
  }, 30_000);

  test("an option set twice, an unknown option, an unknown tag and a missing value fail", async () => {
    expect(await failure(["@example.label A", "@example label=B"])).toBe("entities/Account.ts: @example.label is set twice");
    expect(await failure(["@example.label A", "@example.label B"])).toBe("entities/Account.ts: @example.label is set twice");
    expect(await failure(["@example.lable X"])).toBe("entities/Account.ts: invalid @example: unknown option lable (did you mean label?)");
    expect(await failure(["@nope.label X"])).toBe("entities/Account.ts: unknown tag @nope: no hook or feature defines it");
    expect(await failure(["@example.retention"])).toBe("entities/Account.ts: @example.retention needs a value");
  }, 30_000);
});
