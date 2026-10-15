import { describe, expect, test } from "bun:test";
import { definePostHook, definePreHook, isHookDefinition } from "@quickservice/core";
import { parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { CORE_IMPORT } from "../testing/core-path.ts";
import { createProject } from "../testing/project.ts";
import { parseEndpointHooks } from "./endpoint-tags.ts";
import { scanHooks } from "./scan-hooks.ts";
import { validateHookReferences } from "./validate-hook-references.ts";

const preHook = `import { definePreHook } from ${CORE_IMPORT};\nexport default definePreHook(async () => {});\n`;
const postHook = `import { definePostHook } from ${CORE_IMPORT};\nexport default definePostHook((data) => data);\n`;

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return (error as Error).message;
  }
  throw new Error("expected a BuildError");
};

describe("hook definitions", () => {
  test("definePreHook and definePostHook mark their phase", () => {
    const pre = definePreHook(() => {});
    const post = definePostHook((data) => data);
    expect(isHookDefinition(pre) && pre.phase).toBe("pre");
    expect(isHookDefinition(post) && post.phase).toBe("post");
    expect(isHookDefinition(() => {})).toBe(false);
  });

  test("scanHooks registers each file with its phase", async () => {
    const hooks = await scanHooks(createProject({ "hooks/authorized.ts": preHook, "hooks/sanitize.ts": postHook }));
    expect(hooks.get("authorized")).toEqual({ name: "authorized", phase: "pre", file: "hooks/authorized.ts" });
    expect(hooks.get("sanitize")).toEqual({ name: "sanitize", phase: "post", file: "hooks/sanitize.ts" });
  });
});

describe("invalid hook files", () => {
  test.each(["Authorized", "auth-check", "1hook"])("name %s is rejected", async (name) => {
    expect(await rejection(scanHooks(createProject({ [`hooks/${name}.ts`]: preHook })))).toContain(`hooks/${name}.ts`);
  });
  test.each(["internal", "overrideHooks", "collection", "onDelete", "unique", "hidden"])(
    "reserved name %s is rejected",
    async (name) => {
      expect(await rejection(scanHooks(createProject({ [`hooks/${name}.ts`]: preHook })))).toContain(`hooks/${name}.ts`);
    },
  );
  test("a plain function export is rejected", async () => {
    const message = await rejection(scanHooks(createProject({ "hooks/audit.ts": "export default async () => {};" })));
    expect(message).toContain("hooks/audit.ts");
  });
});

describe("endpoint tags", () => {
  test("with and without args, in order", () => {
    const source = "/** @authorized admin,owner @sanitize */\nexport default async (repos, req, res) => {};";
    expect(parseEndpointHooks(source, "endpoints/get.ts")).toEqual([
      { name: "authorized", args: ["admin", "owner"] },
      { name: "sanitize", args: [] },
    ]);
  });
  test("on a default-exported function and on an exported variable", () => {
    expect(parseEndpointHooks("/** @audit */\nexport default function handler() {}", "f.ts")).toEqual([
      { name: "audit", args: [] },
    ]);
    expect(parseEndpointHooks("/** @audit x */\nconst handler = () => {};\nexport default handler;", "f.ts")).toEqual([
      { name: "audit", args: ["x"] },
    ]);
  });
  test("no tags yields no hooks", () => {
    expect(parseEndpointHooks("export default async () => {};", "f.ts")).toEqual([]);
  });
  test("operation scopes are not allowed on endpoints", () => {
    expect(() => parseEndpointHooks("/** @authorized:create */\nexport default () => {};", "f.ts")).toThrow(BuildError);
  });
  test("duplicate tags are rejected naming the file and tag", () => {
    expect(() => parseEndpointHooks("/** @authorized @authorized */\nexport default () => {};", "endpoints/get.ts")).toThrow(
      "endpoints/get.ts: hook @authorized",
    );
  });
});

describe("unknown hook references", () => {
  test("from an endpoint names the endpoint file and tag", async () => {
    const hooks = await scanHooks(createProject({ "hooks/authorized.ts": preHook }));
    expect(() =>
      validateHookReferences([], [{ file: "endpoints/get.ts", hooks: [{ name: "authorize", args: [] }] }], hooks),
    ).toThrow("endpoints/get.ts: unknown hook @authorize");
  });
  test("from an entity names the entity file and tag", async () => {
    const root = createProject({
      "hooks/authorized.ts": preHook,
      "entities/User.ts": "/** @authorize */\nexport type User = { name: string }",
    });
    const hooks = await scanHooks(root);
    expect(() => validateHookReferences(parseEntities(root), [], hooks)).toThrow("entities/User.ts: unknown hook @authorize");
  });
  test("known hooks pass", async () => {
    const hooks = await scanHooks(createProject({ "hooks/authorized.ts": preHook }));
    expect(() =>
      validateHookReferences([], [{ file: "endpoints/get.ts", hooks: [{ name: "authorized", args: [] }] }], hooks),
    ).not.toThrow();
  });
});
