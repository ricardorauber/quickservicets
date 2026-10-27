import { afterAll, expect, test } from "bun:test";
import { startTestService } from "../testing/service.ts";

/** A local server recording the x-request-id of each path it receives. */
const seen: Record<string, string | null> = {};
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    seen[new URL(request.url).pathname] = request.headers.get("x-request-id");
    return Response.json({ ok: true });
  },
});
afterAll(() => upstream.stop(true));

const base = `http://127.0.0.1:${upstream.port}`;

const FILES = {
  "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), queues: { pollInterval: "50ms" }, http: { allow: ["loopback"] } });
`,
  "jobs/ping.ts": `import { job } from "@quickservicets/core";
export default job("@daily", (ctx) => ctx.http.get("${base}/job").send());
`,
  "queues/ping.ts": `import { queue } from "@quickservicets/core";
export default queue<{ n: number }>((ctx) => ctx.http.get("${base}/consumer").send());
`,
  "endpoints/run-job/post.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.jobs.run("ping");
`,
  "endpoints/enqueue/post.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.queue.add("ping", { n: 1 });
`,
};

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("a job sends its run id as x-request-id, a consumer its message id", async () => {
  const service = await startTestService({ files: FILES });
  try {
    const { runId } = (await (await service.fetch("/run-job", { method: "POST" })).json()) as { runId: string };
    await until(() => "/job" in seen);
    expect(seen["/job"]).toBe(runId);
    const { id } = (await (await service.fetch("/enqueue", { method: "POST" })).json()) as { id: string };
    await until(() => "/consumer" in seen);
    expect(seen["/consumer"]).toBe(id);
  } finally {
    await service.stop();
  }
});
