import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { registerProjectFeatures, type EntityModel } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const config = (queues = "queues: {}", adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter, mongodbAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}${queues ? `, ${queues}` : ""} });
`;
const SEND_EMAIL = `import { queue } from "@quickservicets/core";
export default queue<{ to: string }>(async ({ payload }) => payload.to);
`;
const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { id: string; queue: string; status: string; attempt: number; maxAttempts: number; priority: number; payload: unknown; requestId?: string | null };
type MessageRepos = { queueMessages: { findById(id: string): Promise<Message | null>; query(): { all(): Promise<Message[]> } } };
const messages = (service: TestService) => (service.repos as unknown as MessageRepos).queueMessages;

const BASE = {
  "quickservicets.config.ts": config(),
  "queues/send-email.ts": SEND_EMAIL,
  "endpoints/welcome/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", { to: "a@b.c" });
`,
};

describe("declaring queues", () => {
  test("queue files are named by their path, feature queues get the feature's key, and the registry holds them", async () => {
    const root = createLinkedProject({
      ...BASE,
      "queues/billing/close.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => {});\n',
      "features/example/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "example" });\n',
      "features/example/queues/notify.ts": 'import { queue } from "@quickservicets/core";\nexport default queue<{ id: string }>(() => {});\n',
      "quickservicets.config.ts": config("queues: {}, example: {}"),
    });
    await build(root);
    const { featureFolders } = await import(join(root, ".generated/features.ts"));
    expect([...featureFolders.queues.queues.keys()].sort()).toEqual(["billing/close", "example/notify", "send-email"]);
    const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
    expect(types).toContain('"billing/close": QueuePayloadOf<typeof import("../queues/billing/close.ts").default>;');
    expect(types).toContain('"example/notify": QueuePayloadOf<typeof import("../features/example/queues/notify.ts").default>;');
  });

  test("a queue file without a default queue(...) export fails the build", async () => {
    const root = createLinkedProject({ ...BASE, "queues/broken.ts": "export default { handler() {} };\n" });
    await expect(build(root)).rejects.toThrow("queues/broken.ts: must default-export queue(...)");
  });
});

describe("the QueueMessage entity", () => {
  test("the build adds QueueMessage without routes, and a project without queues builds no queue output", async () => {
    const service = await startTestService({ files: BASE });
    try {
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((model) => model.key === "QueueMessage")).toMatchObject({ system: true, name: "queue-messages", repoKey: "queueMessages", tableName: "queue_messages" });
      expect((await service.fetch("/queue-messages", post({ queue: "x" }))).status).toBe(404);
      expect((await service.fetch("/queue-messages")).status).toBe(404);
    } finally {
      await service.stop();
    }
    const without = createLinkedProject({ "quickservicets.config.ts": config(""), "entities/User.ts": "export type User = { name: string };\n" });
    const off = createLinkedProject({ "quickservicets.config.ts": config("queues: false"), "entities/User.ts": "export type User = { name: string };\n" });
    await build(without);
    await build(off);
    for (const file of readdirSync(join(without, ".generated"))) {
      const content = readFileSync(join(without, ".generated", file), "utf8");
      expect(content).not.toMatch(/Queue|queue_messages|queue-messages/);
      expect(readFileSync(join(off, ".generated", file), "utf8")).toBe(content);
    }
  });

  const adapters = { sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' };
  for (const [name, adapter] of Object.entries(adapters)) {
    test(`${name}: migration add creates the queue_messages table and its index`, async () => {
      const root = createLinkedProject({ ...BASE, "quickservicets.config.ts": config("queues: {}", adapter) });
      const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?queue_messages/);
      expect(created).toMatch(/queue_messages_queue_status_priority_run_at/);
    });
  }

  test("mongodb: migration add creates the queue_messages index", async () => {
    const root = createLinkedProject({ ...BASE, "quickservicets.config.ts": config("queues: {}", 'mongodbAdapter({ url: "mongodb://localhost/none", database: "x" })') });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toContain('collection("queue_messages").createIndex({"queue":1,"status":1,"priority":1,"runAt":1}');
  });
});

describe("adding messages", () => {
  const files = {
    ...BASE,
    "jobs/enqueue.ts": `import { job } from "@quickservicets/core";
export default job({ every: "1h" }, async (ctx) => ctx.queue.add("send-email", { to: "job@b.c" }));
`,
    "endpoints/run-job/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.jobs.run("enqueue");
`,
    "endpoints/core/post.ts": `import { queues } from "@quickservicets/core";
export default async () => queues.add("send-email", { to: "core@b.c" });
`,
    "endpoints/in-transaction/post.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default async (repos: Repositories, req: ServiceRequest) => {
  const { fail } = (await req.json()) as { fail: boolean };
  try {
    await repos.transaction(async () => {
      await req.queue.add("send-email", { to: "tx@b.c" });
      if (fail) throw new Error("rolled back");
    });
  } catch {
    return { rolledBack: true };
  }
  return { rolledBack: false };
};
`,
  };

  test("req.queue.add stores a waiting message with the request id, and returns its id", async () => {
    // Without consumers, the message stays as it was added.
    const service = await startTestService({ files, env: { QS_QUEUES_CONSUME: "false" } });
    try {
      const response = await service.fetch("/welcome", post());
      const added = (await response.json()) as { id: string; deduplicated: boolean };
      expect(added).toEqual({ id: expect.any(String), deduplicated: false });
      const message = await messages(service).findById(added.id);
      expect(message).toMatchObject({ queue: "send-email", status: "waiting", attempt: 0, maxAttempts: 4, priority: 0, payload: { to: "a@b.c" } });
      expect(message?.requestId).toBe(response.headers.get("x-request-id"));
    } finally {
      await service.stop();
    }
  });

  test("ctx.queue.add in a job and queues.add from the core add messages", async () => {
    const service = await startTestService({ files });
    try {
      expect((await service.fetch("/run-job", post())).status).toBe(200);
      expect((await service.fetch("/core", post())).status).toBe(200);
      for (let attempt = 0; attempt < 200 && (await messages(service).query().all()).length < 2; attempt++) await Bun.sleep(5);
      const payloads = (await messages(service).query().all()).map((message) => (message.payload as { to: string }).to).sort();
      expect(payloads).toEqual(["core@b.c", "job@b.c"]);
    } finally {
      await service.stop();
    }
  });

  test("an add inside a transaction exists only once the transaction commits", async () => {
    const service = await startTestService({ files });
    try {
      expect(await (await service.fetch("/in-transaction", post({ fail: true }))).json()).toEqual({ rolledBack: true });
      expect(await messages(service).query().all()).toEqual([]);
      expect(await (await service.fetch("/in-transaction", post({ fail: false }))).json()).toEqual({ rolledBack: false });
      expect((await messages(service).query().all()).map((message) => message.payload)).toEqual([{ to: "tx@b.c" }]);
    } finally {
      await service.stop();
    }
  });
});

function typeErrors(root: string, source: string): string[] {
  const check = join(root, "check.ts");
  writeFileSync(check, source);
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

describe("payload types", () => {
  test("QueuePayloads types add by queue name and payload in endpoints, jobs and features", async () => {
    const root = createLinkedProject(BASE);
    await build(root);
    const source = `import "./.generated/types.ts";
import { defineFeature, queues, type JobContext, type ServiceRequest } from "@quickservicets/core";
export async function endpoint(req: ServiceRequest) {
  const added: { id: string; deduplicated: boolean } = await req.queue.add("send-email", { to: "a@b.c" });
  // @ts-expect-error the queue is send-email
  await req.queue.add("send-mail", { to: "a@b.c" });
  // @ts-expect-error to is a string
  await req.queue.add("send-email", { to: 1 });
  return added;
}
export const inJob = (ctx: JobContext) => ctx.queue.add("send-email", { to: "job@b.c" });
export default defineFeature({
  key: "notifier",
  setup() {
    void queues.add("send-email", { to: "feature@b.c" });
  },
});
`;
    expect(typeErrors(root, source)).toEqual([]);
  });
});
