import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService, type TestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const dir of ["entities", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const get = async (service: TestService, path: string) => {
  const response = await service.fetch(path);
  return [response.status, (await response.json()) as Record<string, any>] as const;
};

test("live answers ok, ready lists the database, the config check and the feature's check", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await get(service, "/health/live")).toEqual([200, { status: "ok" }]);
    const [status, body] = await get(service, "/health/ready");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Object.keys(body.checks).sort()).toEqual(["cache", "database", "mail.smtp"]);
    expect(body.checks.cache).toMatchObject({ status: "ok", critical: true, entries: 3 });
    expect(body.checks["mail.smtp"]).toMatchObject({ status: "ok", critical: false, host: "smtp.example.com" });
  } finally {
    await service.stop();
  }
});

test("a failing non-critical check degrades readiness without failing it", async () => {
  const service = await startTestService({ files: exampleFiles(), env: { QS_MAIL_DOWN: "true" } });
  try {
    const [status, body] = await get(service, "/health/ready");
    expect([status, body.status, body.checks["mail.smtp"].error]).toEqual([200, "degraded", "SMTP server unreachable"]);
  } finally {
    await service.stop();
  }
});

test("on shutdown ready answers draining for the drain delay while other routes keep serving", async () => {
  const service = await startTestService({ files: exampleFiles(), env: { QS_HEALTH_DRAIN_DELAY: "1s" } });
  const started = Date.now();
  const stopping = service.stop();
  await Bun.sleep(100);
  expect(await get(service, "/health/ready")).toEqual([503, { status: "draining" }]);
  expect((await service.fetch("/users")).status).toBe(200);
  await stopping;
  expect(Date.now() - started).toBeGreaterThanOrEqual(950);
});

test("a project endpoint replaces the ready route and reads the checks with runHealthChecks", async () => {
  const service = await startTestService({
    files: {
      ...exampleFiles(),
      "endpoints/health/ready/get.ts": `import { runHealthChecks, type ServiceResponse } from "@quickservice/core";

/** A ready route for a load balancer that only reads the status code and a one-word body. */
export default async (_repos: unknown, _req: unknown, res: ServiceResponse) => {
  const report = await runHealthChecks();
  res.status(report.status === "fail" ? 503 : 200);
  return { ready: report.status !== "fail", failing: Object.keys(report.checks).filter((name) => report.checks[name]!.status === "fail") };
};
`,
    },
  });
  try {
    expect(await get(service, "/health/ready")).toEqual([200, { ready: true, failing: [] }]);
  } finally {
    await service.stop();
  }
});
