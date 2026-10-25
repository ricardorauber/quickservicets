import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { defineFeature, object, registerNative, registerProjectFeatures, string, type FeatureDefinition } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "./build.ts";

const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;

function typeErrors(root: string, source: string): string[] {
  const check = join(root, "check.ts");
  writeFileSync(check, source);
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

const registered: string[] = [];
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
  registerProjectFeatures([]);
});

describe("typed request slots and properties", () => {
  test("RequestUser and RequestExtensions augment ServiceRequest by declaration merging", () => {
    const root = createLinkedProject({ "quickservice.config.ts": config() });
    const source = `import { defineFeature, type ServiceRequest } from "@quickservice/core";
interface Greeter { greet(name: string): string }
declare module "@quickservice/core" {
  interface RequestUser { id: string }
  interface RequestExtensions { example: Greeter }
}
export default defineFeature({
  key: "example",
  request: { example: (req: ServiceRequest): Greeter => ({ greet: (name) => \`Hello, \${name} from \${req.path}\` }) },
  middleware: [{ stage: "handler", run: (req, _res, next) => { req.user = { id: "u1" }; return next(); } }],
});
export function handler(req: ServiceRequest): string {
  const id: string = req.user?.id ?? "";
  return req.example.greet(id);
}
// @ts-expect-error the user has no name field
export const wrong = (req: ServiceRequest) => req.user?.name;
// @ts-expect-error greet takes a string
export const badGreet = (req: ServiceRequest) => req.example.greet(1);
`;
    expect(typeErrors(root, source)).toEqual([]);
  });
});

describe("features end to end", () => {
  test("a feature's request property and handler middleware reach the project's endpoints", async () => {
    registerNative(
      defineFeature({
        key: "example",
        request: { example: (req) => ({ greet: (name: string) => `Hello, ${name}! (${req.method} ${req.route})` }) },
        middleware: [{ stage: "handler", run: (req, _res, next) => ((req.user = { id: "u1" } as never), next()) }],
      }),
    );
    registered.push("example");
    const root = createLinkedProject({
      "quickservice.config.ts": config("example: {}"),
      "endpoints/hello/[name]/get.ts": "export default (_repos: unknown, req: any) => ({ text: req.example.greet(req.params.name), user: req.user });\n",
    });
    await build(root);
    const app = await serveBuilt(root);
    expect((await app.get("/hello/Ana")).body).toEqual({ text: "Hello, Ana! (GET /hello/[name])", user: { id: "u1" } });
  });

  test("optionsFor(req) returns the endpoint's tag options, or the entity's for a generated route", async () => {
    const schema = object({ greeting: string().default("Hello") });
    const audit: FeatureDefinition<typeof schema> = defineFeature({
      key: "audit",
      options: schema,
      tags: { audit: { on: ["entity", "endpoint"], options: ["greeting"], description: "d", example: "e" } },
      middleware: [{ stage: "handler", run: (req, res, next) => (res.header("x-greeting", String(audit.optionsFor(req).greeting)), next()) }],
    });
    registerNative(audit);
    registered.push("audit");
    const root = createLinkedProject({
      "quickservice.config.ts": config("audit: {}"),
      "entities/Post.ts": '/** @audit greeting="Good day" */\nexport type Post = { title: string };\n',
      "entities/Comment.ts": "export type Comment = { body: string };\n",
      "endpoints/stats/get.ts": "/** @audit greeting=Stats */\nexport default () => ({ ok: true });\n",
    });
    await build(root);
    const app = await serveBuilt(root);
    const header = async (path: string) => (await app.server.fetch(new Request(`http://localhost${path}`))).headers.get("x-greeting");
    expect(await header("/stats")).toBe("Stats");
    expect(await header("/posts")).toBe("Good day");
    expect(await header("/comments")).toBe("Hello");
  });
});
