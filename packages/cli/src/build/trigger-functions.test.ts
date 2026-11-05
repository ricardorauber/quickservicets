import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildMachinePlatform, memoryAdapter, registerProjectFeatures, runAzureFunctions, runLambda, testDelivery, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { azureFunctionFiles } from "./deploy.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => registerProjectFeatures([]));

/** A project feature registering a `queue` source: a raw `{ queue, messages }` is one event per message, with an Azure queue binding. */
const QUEUE_FEATURE = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "cloudqueue",
  enabledByDefault: true,
  requires: ["triggers"],
  setup(ctx) {
    ctx.feature("triggers").source("queue", {
      kind: "queue",
      recognize: (_platform, raw) => typeof raw?.queue === "string" || typeof raw?.invocation?.Data?.message === "string",
      decode: (raw) => {
        const messages = raw.messages ?? [raw.invocation.Data.message];
        return messages.map((body, index) => ({ id: \`m\${index}\`, kind: "queue", type: "message", time: new Date(0), data: { body }, attributes: {}, attempt: 1 }));
      },
      matches: () => true,
      result: (outcomes) => ({ failed: outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.eventId) }),
      describe: (ref) => ({ azure: { type: "queueTrigger", queueName: ref.queue, connection: "AzureWebJobsStorage" } }),
    });
  },
});
`;
const ORDERS = `import { trigger } from "@quickservicets/core";
export const seen: string[] = [];
export default trigger<{ body: string }>({
  source: { kind: "queue", queue: "orders" },
  handle({ event }) {
    if (event.data.body === "bad") throw new Error("bad order");
    seen.push(event.data.body);
  },
});
`;
const UPLOADS = `import { testSource, trigger } from "@quickservicets/core";
export const seen: string[] = [];
export default trigger<{ key: string }>({ source: testSource(), handle: ({ event }) => void seen.push(event.data.key) });
`;

const project = (extra: string, files: Record<string, string>) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "shop" }), "quickservicets.config.ts": `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ triggers: {}${extra} });\n`, ...files });
  roots.push(root);
  return root;
};

const cli = async (args: string[], root: string) => {
  const err: string[] = [];
  const code = await run(args, { log: () => {}, error: (line) => err.push(line) }, root);
  return { code, err };
};

/** The generated inputs of a project, for the platform runners in this process. */
async function generated(root: string): Promise<Omit<StartServiceOptions, "projectConfig">> {
  await build(root, {});
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  return { models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: dir, env: {} };
}

const quiet = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

/** A fake Lambda Runtime API: hands out the events in order and records what the function posts back. */
function fakeRuntime(events: unknown[]) {
  const posted: { kind: string; body: string }[] = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/2018-06-01/runtime/invocation/next") {
        if (next >= events.length) return new Promise<Response>(() => {});
        return Response.json(events[next++], { headers: { "lambda-runtime-aws-request-id": `request-${next}`, "lambda-runtime-deadline-ms": String(Date.now() + 30_000) } });
      }
      const match = /\/invocation\/[^/]+\/(response|error)$/.exec(path);
      posted.push({ kind: match?.[1] ?? path, body: await request.text() });
      return new Response(null, { status: 202 });
    },
  });
  return { api: `127.0.0.1:${server.port}`, posted, stop: () => server.stop(true) };
}

describe("lambda", () => {
  test("a test delivery reaches the matching trigger through the Runtime API loop, the source's result is the response, and an unknown event fails as unsupported", async () => {
    const root = project("", { "triggers/uploads.ts": UPLOADS });
    const inputs = await generated(root);
    const runtime = fakeRuntime([testDelivery([{ id: "e1", data: { key: "a.png" } }]), { Records: [{ eventSource: "aws:unknown" }] }]);
    try {
      await runLambda({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger, triggers: {} } as ServiceConfig, handleSigterm: false }, { runtimeApi: runtime.api, invocations: 2 });
      const { seen } = (await import(join(root, "triggers/uploads.ts"))) as { seen: string[] };
      expect(seen).toEqual(["a.png"]);
      expect(runtime.posted[0]).toEqual({ kind: "response", body: JSON.stringify({ batchItemFailures: [] }) });
      expect(runtime.posted[1]!.kind).toBe("error");
      expect(JSON.parse(runtime.posted[1]!.body).errorMessage).toBe("Unsupported Lambda event");
    } finally {
      runtime.stop();
    }
  });
});

describe("azure-functions", () => {
  test("azureFunctionFiles writes a trigger-<name> function.json per trigger from its binding and fails for a trigger without one", () => {
    const { files, triggers } = azureFunctionFiles("shop", { authLevel: "anonymous", extensionBundle: true }, [], [], [{ name: "orders/new", kind: "queue", binding: { type: "queueTrigger", queueName: "orders", connection: "AzureWebJobsStorage" } }]);
    expect(triggers).toEqual({ "trigger-orders-new": "orders/new" });
    expect(JSON.parse(files["trigger-orders-new/function.json"]!)).toEqual({ bindings: [{ name: "event", direction: "in", type: "queueTrigger", queueName: "orders", connection: "AzureWebJobsStorage" }] });
    expect(() => azureFunctionFiles("shop", { authLevel: "anonymous", extensionBundle: true }, [], [], [{ name: "uploads", kind: "test" }])).toThrow("triggers/uploads: source test cannot run on azure-functions");
  });

  test("the build fails for a source without an Azure binding, writes the binding of one that has it, and the handler dispatches the function's invocations", async () => {
    const failing = project("", { "triggers/uploads.ts": UPLOADS });
    expect(await cli(["build", "--target", "azure-functions"], failing)).toEqual({ code: 1, err: ["triggers/uploads: source test cannot run on azure-functions"] });

    const root = project(`, deploy: { platform: "${buildMachinePlatform()}" }`, { "features/cloudqueue/index.ts": QUEUE_FEATURE, "triggers/orders.ts": ORDERS });
    expect((await cli(["build", "--target", "azure-functions"], root)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "dist/azure-functions/trigger-orders/function.json"), "utf8"))).toEqual({ bindings: [{ name: "event", direction: "in", type: "queueTrigger", queueName: "orders", connection: "AzureWebJobsStorage" }] });

    const inputs = await generated(root);
    const server = await runAzureFunctions({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger, triggers: {} } as ServiceConfig, handleSigterm: false }, { port: 0, triggers: { "trigger-orders": "orders" } });
    try {
      const post = (message: string) => fetch(`http://127.0.0.1:${server.port}/trigger-orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Data: { message }, Metadata: {} }) });
      const ok = await post("first");
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { ReturnValue: unknown }).ReturnValue).toEqual({ failed: [] });
      expect(((await (await post("bad")).json()) as { ReturnValue: unknown }).ReturnValue).toEqual({ failed: ["m0"] });
      const { seen } = (await import(join(root, "triggers/orders.ts"))) as { seen: string[] };
      expect(seen).toEqual(["first"]);
    } finally {
      await server.stop();
    }
  }, 180_000);
});
