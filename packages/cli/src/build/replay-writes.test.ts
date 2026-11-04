import { afterEach, describe, expect, test } from "bun:test";
import { runAsCommand, withWriteCause } from "@quickservicets/core";
import { build } from "./build.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

type Seen = { causes: string[]; events: string[] };
const seen = () => (globalThis as unknown as { replaySeen: Seen }).replaySeen;

/** A feature recording the cause of every write and every event a listener receives. */
const PROBE = `import { defineFeature, defineCommand, events, observeWrites, withWriteCause } from "@quickservicets/core";
const seen = () => (globalThis as unknown as { replaySeen: { causes: string[]; events: string[] } }).replaySeen;
export default defineFeature({
  key: "probe",
  requires: ["events"],
  commands: [
    defineCommand({
      name: "probe replay",
      usage: "quickservicets probe replay",
      description: "Creates a user as a replay.",
      async run(ctx) {
        const repos = (await ctx.connect()) as any;
        await withWriteCause("replay", () => repos.users.create({ email: "cli@example.com" }));
        ctx.output.log("replayed");
      },
    }),
  ],
  setup(ctx) {
    const stop = observeWrites({ write: (change) => void seen().causes.push(change.entity.key + " " + change.operation + " " + change.cause) });
    ctx.app.onStop(stop);
    ctx.app.onStart(() => void events.on("*", (event) => void seen().events.push(event.type)));
  },
});
`;
const ENDPOINT = `import { withWriteCause, type ServiceRequest } from "@quickservicets/core";
export default async (repos: any, _req: ServiceRequest) => {
  try {
    await withWriteCause("replay", () => repos.users.create({ email: "endpoint@example.com" }));
    return { allowed: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
`;
const FILES = {
  "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), events: { outbox: true }, history: {}, probe: {}, logger: { info() {}, warn() {}, error() {} } });
`,
  "features/probe/index.ts": PROBE,
  "entities/User.ts": "/** @history */\nexport type User = { email: string };\n",
  "entities/Post.ts": 'import type { User } from "./User";\nexport type Post = { title: string; /** @onDelete cascade */ author: User };\n',
  "endpoints/replay/post.ts": ENDPOINT,
};

async function start() {
  (globalThis as unknown as { replaySeen: Seen }).replaySeen = { causes: [], events: [] };
  const service = await startTestService({ files: FILES });
  running.push(service);
  return service;
}
const repos = (service: TestService) => service.repos as any;
const settle = () => Bun.sleep(50);

describe("withWriteCause", () => {
  test("every write inside it reports replay to write observers, cascades included", async () => {
    const service = await start();
    await runAsCommand(() =>
      withWriteCause("replay", async () => {
        const user = await repos(service).users.create({ email: "a@example.com" });
        await repos(service).posts.create({ title: "p", author: user.id });
        await repos(service).users.update(user.id, { email: "b@example.com" });
        await repos(service).users.delete(user.id);
      }),
    );
    expect(seen().causes).toEqual(["User created replay", "Post created replay", "User updated replay", "Post deleted replay", "User deleted replay"]);
    // Outside the function, the causes are the writes' own again.
    const user = await repos(service).users.create({ email: "c@example.com" });
    await repos(service).posts.create({ title: "q", author: user.id });
    await repos(service).users.delete(user.id);
    expect(seen().causes.slice(5)).toEqual(["User created write", "Post created write", "Post deleted cascade", "User deleted write"]);
  }, 30_000);

  test("replayed writes store no outbox row and no history version, and listeners receive nothing", async () => {
    const service = await start();
    let id = "";
    await runAsCommand(() =>
      withWriteCause("replay", async () => {
        id = (await repos(service).users.create({ email: "a@example.com" })).id;
        await repos(service).users.update(id, { email: "b@example.com" });
      }),
    );
    await settle();
    expect(seen().events).toEqual([]);
    expect(await repos(service).outboxEvents.count()).toBe(0);
    // A record without versions answers 404 on its history route.
    expect((await service.fetch(`/users/${id}/history`)).status).toBe(404);
    // The same writes without the function do write them.
    await repos(service).users.update(id, { email: "c@example.com" });
    await settle();
    expect(seen().events).toEqual(["user.updated"]);
    expect(await repos(service).outboxEvents.count()).toBe(1);
    expect(((await (await service.fetch(`/users/${id}/history`)).json()) as { total: number }).total).toBe(1);
  }, 30_000);

  test("an endpoint may not call it; a CLI command may, while a service serves", async () => {
    const service = await start();
    expect(await (await service.fetch("/replay", { method: "POST" })).json()).toEqual({ error: "withWriteCause is not allowed during requests" });
    expect((await repos(service).users.list({})).total).toBe(0);
    expect(await withWriteCause("replay", () => 1).catch((error: Error) => error.message)).toBe("withWriteCause is not allowed during requests");

    const root = createLinkedProject(FILES);
    await build(root);
    const out: string[] = [];
    const code = await run(["probe", "replay"], { log: (line) => out.push(line), error: (line) => out.push(line) }, root);
    expect({ code, out }).toEqual({ code: 0, out: ["replayed"] });
  }, 30_000);
});
