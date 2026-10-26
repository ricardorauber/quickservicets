import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { events, readOutbox, type AnyEvent } from "@quickservicets/core";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of ["quickservicets.config.ts", "event-map.ts"]) files[file] = readFileSync(join(root, file), "utf8");
  for (const dir of ["entities", "endpoints", "events", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const send = (method: string, body: unknown = {}) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Rows<T> = { query(): { toArray(): Promise<T[]> }; findById(id: string): Promise<T | null> };
type Repos = { posts: Rows<{ id: string; commentCount: number; published: boolean }>; notifications: Rows<{ channel: string; postId: string }>; outboxDeliveries: Rows<{ consumer: string; status: string }> };
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 300 && !(await check()); attempt++) await Bun.sleep(10);
};

test("the comment counter follows comments, and deleting a post cascades to its comments as events", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const repos = service.repos as unknown as Repos;
    const post = (await (await service.fetch("/posts", send("POST", { title: "Hello" }))).json()) as { id: string };
    const first = (await (await service.fetch("/comments", send("POST", { body: "one", post: post.id }))).json()) as { id: string };
    await service.fetch("/comments", send("POST", { body: "two", post: post.id }));
    await events.idle();
    expect((await repos.posts.findById(post.id))!.commentCount).toBe(2);
    await service.fetch(`/comments/${first.id}`, { method: "DELETE" });
    await events.idle();
    expect((await repos.posts.findById(post.id))!.commentCount).toBe(1);

    const deleted: string[] = [];
    events.on("*.deleted", (event) => void deleted.push(`${event.type}:${(event as { cause: string }).cause}`));
    await service.fetch(`/posts/${post.id}`, { method: "DELETE" });
    await events.idle();
    expect(deleted).toEqual(["comment.deleted:cascade", "post.deleted:write"]);
  } finally {
    await service.stop();
  }
});

test("post.published reaches listeners only after a committed publish, never after a failed one", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const repos = service.repos as unknown as Repos;
    const published: AnyEvent[] = [];
    let committed: boolean | undefined;
    const post = (await (await service.fetch("/posts", send("POST", { title: "Hello" }))).json()) as { id: string };
    events.on("post.published", async (event) => {
      committed = (await repos.posts.findById(post.id))!.published;
      published.push(event);
    });
    expect((await service.fetch(`/posts/${post.id}/publish`, send("POST", { dryRun: true }))).status).toBe(409);
    await events.idle();
    expect(published).toEqual([]);
    expect((await repos.posts.findById(post.id))!.published).toBe(false);
    expect((await service.fetch(`/posts/${post.id}/publish`, send("POST"))).status).toBe(200);
    await events.idle();
    expect(published.map((event) => event.type)).toEqual(["post.published"]);
    expect(committed).toBe(true);
    expect((await repos.notifications.query().toArray()).map((sent) => sent.channel)).toEqual(["in-app"]);
  } finally {
    await service.stop();
  }
});

test("with the outbox on, events are stored and the notify/email consumer gets its delivery", async () => {
  const service = await startTestService({ files: exampleFiles(), env: { QS_EVENTS_OUTBOX_ENABLED: "true" } });
  try {
    const repos = service.repos as unknown as Repos;
    const post = (await (await service.fetch("/posts", send("POST", { title: "Hello" }))).json()) as { id: string };
    await service.fetch(`/posts/${post.id}/publish`, send("POST"));
    expect((await readOutbox()).map((record) => record.type)).toEqual(["post.created", "post.updated", "post.published"]);
    await settle(async () => (await repos.outboxDeliveries.query().toArray()).every((row) => row.status === "delivered"));
    expect(await repos.outboxDeliveries.query().toArray()).toEqual([expect.objectContaining({ consumer: "notify/email", status: "delivered" })]);
    expect((await repos.notifications.query().toArray()).map((sent) => sent.channel).sort()).toEqual(["email", "in-app"]);
  } finally {
    await service.stop();
  }
});

test("a project events/notify.ts replaces the notify feature's file", async () => {
  const replacement = `import { listen } from "@quickservicets/core";
export default listen("post.published", async (event, { repos }) => {
  await repos.notifications.create({ channel: "project", postId: event.payload.postId });
});
`;
  const service = await startTestService({ files: { ...exampleFiles(), "events/notify.ts": replacement } });
  try {
    const repos = service.repos as unknown as Repos;
    const post = (await (await service.fetch("/posts", send("POST", { title: "Hello" }))).json()) as { id: string };
    await service.fetch(`/posts/${post.id}/publish`, send("POST"));
    await events.idle();
    expect((await repos.notifications.query().toArray()).map((sent) => sent.channel)).toEqual(["project"]);
  } finally {
    await service.stop();
  }
});
