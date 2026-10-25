import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/health");

/** The files of a project folder, as `startTestService` takes them, without generated and installed files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const get = async (service: TestService, path: string) => {
  const response = await service.fetch(path);
  return [response.status, (await response.json()) as Record<string, any>] as const;
};

test("quickservice eject health turns the native into features/health/ and the checks, details and draining keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "health");
  expect(lines).toContain("features/health/ now replaces the health native.");
  expect(existsSync(join(root, "features/health/checks.ts"))).toBe(true);

  const service = await startTestService({ files: filesOf(root), env: { QS_MAIL_DOWN: "true", QS_HEALTH_DRAIN_DELAY: "1s" } });
  expect(await get(service, "/health/live")).toEqual([200, { status: "ok" }]);
  const [status, body] = await get(service, "/health/ready");
  expect([status, body.status, Object.keys(body.checks).sort(), body.checks["mail.smtp"].error]).toEqual([200, "degraded", ["cache", "database", "mail.smtp"], "SMTP server unreachable"]);
  const stopping = service.stop();
  await Bun.sleep(100);
  expect(await get(service, "/health/ready")).toEqual([503, { status: "draining" }]);
  await stopping;
});
