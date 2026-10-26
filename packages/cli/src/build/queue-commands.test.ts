import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueMessageEntity, sqliteAdapter } from "@quickservicets/core";
import { build } from "./build.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const SEND_EMAIL = 'import { queue } from "@quickservicets/core";\nexport default queue<{ to: string }>(() => {});\n';
const sqliteConfig = (path: string) =>
  `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), queues: {}, logger: { info() {}, warn() {}, error() {} } });\n`;

/** A migrated SQLite project with the queues native and a way to insert messages and run the CLI. */
async function sqliteProject() {
  const root = createLinkedProject({ "quickservicets.config.ts": "", "queues/send-email.ts": SEND_EMAIL });
  const path = join(root, "data.db");
  writeFileSync(join(root, "quickservicets.config.ts"), sqliteConfig(path));
  await build(root);
  await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 15, 12)));
  await migrate(root);
  const model = queueMessageEntity();
  const withAdapter = async <T>(fn: (adapter: ReturnType<typeof sqliteAdapter>) => Promise<T>) => {
    const adapter = sqliteAdapter({ path });
    await adapter.connect([model]);
    try {
      return await fn(adapter);
    } finally {
      await adapter.disconnect();
    }
  };
  const insert = (fields: Record<string, unknown>) =>
    withAdapter(async (adapter) => {
      const now = new Date();
      const id = Bun.randomUUIDv7();
      await adapter.insert(model, { id, createdAt: now, updatedAt: now, queue: "send-email", payload: {}, status: "waiting", priority: 0, runAt: now, attempt: 0, maxAttempts: 4, enqueuedAt: now, ...fields } as never);
      return id;
    });
  const find = (id: string) => withAdapter((adapter) => adapter.findById(model, id));
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  return { root, insert, find, cli };
}

describe("queue commands", () => {
  test("queue list, queue dead and queue retry print the queues, the dead messages and the requeued count", async () => {
    const { insert, find, cli } = await sqliteProject();
    const now = Date.now();
    await insert({ status: "waiting", enqueuedAt: new Date(now - 65_000) });
    await insert({ status: "waiting", enqueuedAt: new Date(now - 5000) });
    const deadId = await insert({ status: "dead", attempt: 4, finishedAt: new Date(now - 1000), lastError: { message: "smtp down" } });

    const list = await cli("queue", "list");
    expect(list.code).toBe(0);
    expect(list.out).toHaveLength(1);
    expect(list.out[0]).toMatch(/^send-email: waiting 2, active 0, completed 0, dead 1; oldest waiting 1m [56]s$/);

    const dead = await cli("queue", "dead", "send-email", "--limit", "1");
    expect(dead.code).toBe(0);
    expect(dead.out).toEqual([`${deadId}  attempts 4  ${new Date(now - 1000).toISOString()}  smtp down`]);

    const retried = await cli("queue", "retry", "--queue", "send-email", "--dead");
    expect(retried).toEqual({ code: 0, out: ["Requeued 1 message"], err: [] });
    expect(await find(deadId)).toMatchObject({ status: "waiting", attempt: 0 });

    expect(await cli("queue", "retry", "nope")).toEqual({ code: 1, out: [], err: ["Queue message nope not found"] });
    expect(await cli("queue", "retry", deadId)).toEqual({ code: 1, out: [], err: [`Queue message ${deadId} is not dead`] });
    expect((await cli("queue", "retry")).code).toBe(1);
    expect(await cli("queue", "dead", "send-email")).toEqual({ code: 0, out: ["No dead messages in send-email."], err: [] });
  });

  test("quickservicets help lists the three commands under queues", async () => {
    const { cli } = await sqliteProject();
    const help = (await cli("help")).out.join("\n");
    const section = help.slice(help.indexOf("queues:"));
    expect(help).toContain("queues:");
    for (const command of ["queue list", "queue dead", "queue retry"]) expect(section).toContain(`  ${command} `);
  });

  test("the reference page of the native lists the three commands", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/queues.mdx"), "utf8");
    for (const command of ["quickservicets queue list", "quickservicets queue dead <queue>", "quickservicets queue retry <message id>"]) expect(page).toContain(command);
  });
});

const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { id: string; status: string; attempt: number };
type Repos = { queueMessages: { findById(id: string): Promise<Message | null>; query(): { all(): Promise<Message[]> } } };
const messages = (service: TestService) => (service.repos as unknown as Repos).queueMessages;
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await check()); attempt++) await Bun.sleep(10);
};

describe("reprocessing from code", () => {
  test("queues.retry runs a dead message again from attempt 1, and queues.retryDead returns the count", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), queues: { retries: 0 } });
`,
        "queues/send-email.ts": `import { queue } from "@quickservicets/core";
const state = ((globalThis as { mail?: { fail: boolean; attempts: number[] } }).mail = { fail: true, attempts: [] });
export default queue(({ message }) => {
  state.attempts.push(message.attempt);
  if (state.fail) throw new Error("smtp down");
});
`,
        "endpoints/send/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", {});
`,
        "endpoints/retry/post.ts": `import { queues, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => {
  const { id } = (await req.json()) as { id?: string };
  if (id) {
    await queues.retry(id);
    return { retried: 1 };
  }
  return { retried: await queues.retryDead("send-email") };
};
`,
      },
    });
    const mail = () => (globalThis as unknown as { mail: { fail: boolean; attempts: number[] } }).mail;
    try {
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) ids.push(((await (await service.fetch("/send", post())).json()) as { id: string }).id);
      await settle(async () => (await messages(service).query().all()).every((message) => message.status === "dead"));
      mail().fail = false;
      expect(await (await service.fetch("/retry", post({ id: ids[0] }))).json()).toEqual({ retried: 1 });
      await settle(async () => (await messages(service).findById(ids[0]!))?.status === "completed");
      expect(await messages(service).findById(ids[0]!)).toMatchObject({ status: "completed", attempt: 1 });
      expect(await (await service.fetch("/retry", post())).json()).toEqual({ retried: 2 });
      await settle(async () => (await messages(service).query().all()).every((message) => message.status === "completed"));
      expect(mail().attempts).toEqual([1, 1, 1, 1, 1, 1]);
    } finally {
      await service.stop();
    }
  });
});
