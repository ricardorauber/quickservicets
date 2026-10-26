import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "features", "jobs"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const as = (user?: string): { headers: Record<string, string> } => ({ headers: user ? { "x-user-id": user } : {} });
const checkout = (service: { fetch(path: string, init?: RequestInit): Promise<Response> }, user: string) => service.fetch("/checkout", { method: "POST", ...as(user) });

test("GET /settings answers the caller's flags: checkout-v2 for u1, not for an anonymous caller", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/settings", as("u1"))).json()).toEqual({ "checkout-v2": true, "dark-mode": true });
    expect(((await (await service.fetch("/settings")).json()) as Record<string, boolean>)["checkout-v2"]).toBe(false);
  } finally {
    await service.stop();
  }
});

test("POST /checkout answers 404 Route not found to u2 and 200 to u1; QS_FLAGS_RULES_CHECKOUT_V2=false hides it from u1", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const hidden = await checkout(service, "u2");
    expect([hidden.status, ((await hidden.json()) as { error: { message: string } }).error.message]).toEqual([404, "Route not found"]);
    expect([(await checkout(service, "u1")).status]).toEqual([200]);
  } finally {
    await service.stop();
  }
  const off = await startTestService({ files: exampleFiles(), env: { QS_FLAGS_RULES_CHECKOUT_V2: "false" } });
  try {
    expect((await checkout(off, "u1")).status).toBe(404);
  } finally {
    await off.stop();
  }
});

test("the job reads flags for a user it names", async () => {
  const files = exampleFiles();
  // A test-only route that starts the job now.
  files["endpoints/run-report/post.ts"] = 'import type { Repositories, ServiceRequest } from "@quickservice/core";\nexport default (_repos: Repositories, req: ServiceRequest) => req.jobs.run("flag-report");\n';
  const service = await startTestService({ files });
  try {
    const { runId } = (await (await service.fetch("/run-report", { method: "POST" })).json()) as { runId: string };
    type Run = { status: string; result?: unknown };
    const runs = (service.repos as unknown as { jobRuns: { findById(id: string): Promise<Run | null> } }).jobRuns;
    for (let tries = 0; tries < 200 && (await runs.findById(runId))?.status !== "success"; tries++) await Bun.sleep(10);
    expect((await runs.findById(runId))!.result).toEqual({ checkoutForU1: true, darkMode: true });
  } finally {
    await service.stop();
  }
});
