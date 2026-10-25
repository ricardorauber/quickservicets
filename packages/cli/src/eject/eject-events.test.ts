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
    type Rows<T> = { query(): { all(): Promise<T[]> }; findById(id: string): Promise<T | null> };
    const repos = service.repos as unknown as { posts: Rows<{ commentCount: number }>; notifications: Rows<{ channel: string }> };
    const created = (await (await service.fetch("/posts", post({ title: "Hello" }))).json()) as { id: string };
    await service.fetch("/comments", post({ body: "one", post: created.id }));
    await events.idle();
    expect((await repos.posts.findById(created.id))!.commentCount).toBe(1);
    expect((await service.fetch(`/posts/${created.id}/publish`, post({}))).status).toBe(200);
    await events.idle();
    expect((await repos.notifications.query().all()).map((sent) => sent.channel)).toEqual(["in-app"]);
  } finally {
    await service.stop();
  }
});
