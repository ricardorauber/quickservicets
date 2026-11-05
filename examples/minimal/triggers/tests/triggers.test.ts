import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAdapter, registerProjectFeatures, runLambda, testDelivery, type ServiceConfig } from "@quickservicets/core";
import { emitTrigger } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = (extra: Record<string, string> = {}) => ({
  "quickservicets.config.ts": read("quickservicets.config.ts"),
  "entities/Upload.ts": read("entities/Upload.ts"),
  "triggers/new-upload.ts": read("triggers/new-upload.ts"),
  "triggers/billing-events.ts": read("triggers/billing-events.ts"),
  ...extra,
});
// Each service registers its project features; none leaks into the next test.
afterEach(() => registerProjectFeatures([]));

const uploads = async (service: { fetch(path: string): Promise<Response> }) => ((await (await service.fetch("/uploads")).json()) as { data: { key: string }[] }).data.map((upload) => upload.key);

describe("CloudEvents pushes", () => {
  test("a binary and a structured CloudEvent posted to the push route each create an Upload", async () => {
    const service = await startTestService({ files: files() });
    try {
      const binary = await service.fetch("/_triggers/new-upload", {
        method: "POST",
        headers: { "content-type": "application/json", "ce-specversion": "1.0", "ce-id": "evt-1", "ce-source": "/buckets/photos", "ce-type": "storage.object.created" },
        body: JSON.stringify({ key: "photos/a.png" }),
      });
      expect(binary.status).toBe(204);
      const structured = await service.fetch("/_triggers/new-upload", {
        method: "POST",
        headers: { "content-type": "application/cloudevents+json" },
        body: JSON.stringify({ specversion: "1.0", id: "evt-2", source: "/buckets/photos", type: "storage.object.created", data: { key: "photos/b.png" } }),
      });
      expect(structured.status).toBe(204);
      expect((await uploads(service)).sort()).toEqual(["photos/a.png", "photos/b.png"]);
      const billing = await service.fetch("/_triggers/billing-events", { method: "POST", headers: { "content-type": "application/cloudevents-batch+json" }, body: JSON.stringify([{ specversion: "1.0", id: "b1", source: "/billing", type: "billing.invoice.paid", data: { invoice: "inv_1" } }]) });
      expect(billing.status).toBe(204);
    } finally {
      await service.stop();
    }
  });

  test("emitTrigger runs a trigger without HTTP", async () => {
    const service = await startTestService({ files: files() });
    try {
      expect((await emitTrigger("new-upload" as never, { key: "photos/c.png" } as never)).status).toBe("completed");
      expect(await uploads(service)).toEqual(["photos/c.png"]);
    } finally {
      await service.stop();
    }
  });
});

/** A fake Lambda Runtime API: hands out the events in order and records what the function posts back. */
function fakeRuntime(events: unknown[]) {
  const posted: { kind: string; body: unknown }[] = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/2018-06-01/runtime/invocation/next") {
        if (next >= events.length) return new Promise<Response>(() => {});
        return Response.json(events[next++], { headers: { "lambda-runtime-aws-request-id": `request-${next}`, "lambda-runtime-deadline-ms": String(Date.now() + 30_000) } });
      }
      posted.push({ kind: path.endsWith("/response") ? "response" : "error", body: await request.json() });
      return new Response(null, { status: 202 });
    },
  });
  return { api: `127.0.0.1:${server.port}`, posted, stop: () => server.stop(true) };
}

describe("the lambda entry", () => {
  test("a batch of test events with one failing answers with only that event in batchItemFailures", async () => {
    // A trigger on the test source stands for a cloud queue trigger in the function.
    const extra = { "triggers/queue-batch.ts": 'import { testSource, trigger } from "@quickservicets/core";\nexport default trigger<{ order: string }>({ source: testSource(), handle({ event }) { if (event.data.order === "bad") throw new Error("bad order"); } });\n' };
    const service = await startTestService({ files: files(extra) });
    const generated = join(service.root, ".generated");
    const { models } = await import(join(generated, "models.ts"));
    const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
    const { jobs } = await import(join(generated, "jobs.ts"));
    const { features, featureFolders } = await import(join(generated, "features.ts"));
    const runtime = fakeRuntime([testDelivery([{ id: "m1", data: { order: "ok" } }, { id: "m2", data: { order: "bad" } }, { id: "m3", data: { order: "ok" } }])]);
    try {
      const projectConfig = { database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, triggers: {} } as ServiceConfig;
      await runLambda({ projectConfig, models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: generated, env: {}, handleSigterm: false }, { runtimeApi: runtime.api, invocations: 1 });
      expect(runtime.posted).toEqual([{ kind: "response", body: { batchItemFailures: [{ itemIdentifier: "m2" }] } }]);
    } finally {
      runtime.stop();
      await service.stop();
    }
  });
});
