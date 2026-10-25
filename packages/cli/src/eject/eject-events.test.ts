import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { events } from "@quickservice/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/events");

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

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("quickservice eject events turns the native into features/events/ and the example keeps working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "events");
  expect(lines).toContain("features/events/ now replaces the events native.");
  expect(existsSync(join(root, "features/events/index.ts"))).toBe(true);
  expect(readFileSync(join(root, "features/events/bus.ts"), "utf8")).toContain('from "@quickservice/core"');

  const service = await startTestService({ files: filesOf(root) });
  try {
    const created = (await (await service.fetch("/users", post({ name: "Ada", email: "ada@example.com" }))).json()) as { id: string };
    await service.fetch(`/users/${created.id}`, { ...post({ name: "Ada L." }), method: "PATCH" });
    expect((await service.fetch("/users", post({ name: "Bob", email: "nope" }))).status).toBe(400);
    await events.idle();
    const audit = (service.repos as unknown as { auditEntries: { query(): { all(): Promise<{ type: string }[]> } } }).auditEntries;
    for (let attempt = 0; attempt < 100 && (await audit.query().all()).length < 2; attempt++) await Bun.sleep(10);
    expect((await audit.query().all()).map((entry) => entry.type).sort()).toEqual(["user.created", "user.updated"]);
  } finally {
    await service.stop();
  }
});
