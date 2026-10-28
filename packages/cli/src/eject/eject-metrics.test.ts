import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/metrics");

/** The files of a project folder, as `startTestService` takes them, without generated, installed and test files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests|migrations)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("quickservicets eject metrics turns the native into features/metrics/ and usage is still counted and served", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "metrics");
  expect(lines).toContain("features/metrics/ now replaces the metrics native.");
  expect(existsSync(join(root, "features/metrics/index.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    for (let i = 0; i < 3; i++) await service.fetch("/posts/feed", { headers: { "x-tenant-id": "acme" } });
    await service.fetch("/internal/ping");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const body = (await (await service.fetch("/_metrics", { peer: "127.0.0.1" })).json()) as { totals: { requests: number }; series: { tenant: string }[] };
    expect(body.totals.requests).toBe(3);
    expect(body.series[0]!.tenant).toBe("acme");
    expect((await service.fetch("/_metrics", { peer: "203.0.113.20" })).status).toBe(403);
  } finally {
    await service.stop();
  }
});
