import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/idempotency");

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

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("quickservice eject idempotency turns the native into features/idempotency/ and keys keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "idempotency");
  expect(lines).toContain("features/idempotency/ now replaces the idempotency native.");
  expect(existsSync(join(root, "features/idempotency/store.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    const first = await service.fetch("/orders", post({ item: "book", quantity: 1 }, { "idempotency-key": "k1" }));
    const again = await service.fetch("/orders", post({ item: "book", quantity: 1 }, { "idempotency-key": "k1" }));
    expect([first.status, again.status, again.headers.get("idempotent-replayed")]).toEqual([201, 201, "true"]);
    expect((await service.fetch("/orders", post({ item: "book", quantity: 2 }, { "idempotency-key": "k1" }))).status).toBe(422);
    expect((await service.fetch("/orders", post({ item: "book", quantity: 1 }))).status).toBe(400);
    const [a, b] = await Promise.all([service.fetch("/payments", post({ amount: 1 }, { "idempotency-key": "p1" })), service.fetch("/payments", post({ amount: 1 }, { "idempotency-key": "p1" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  } finally {
    await service.stop();
  }
});
