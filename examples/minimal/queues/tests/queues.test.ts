import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { queues } from "@quickservicets/core";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of ["quickservicets.config.ts", "memory-broker.ts"]) files[file] = readFileSync(join(root, file), "utf8");
  for (const dir of ["entities", "endpoints", "queues", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const send = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Rows<T> = { query(): { toArray(): Promise<T[]> }; findById(id: string): Promise<T | null> };
type Message = { id: string; queue: string; status: string; attempt: number; result?: unknown; lastError?: { message: string } | null };
type Repos = { outboxes: Rows<{ to: string; subject: string }>; queueMessages: Rows<Message> };
const repos = (service: TestService) => service.repos as unknown as Repos;
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await check()); attempt++) await Bun.sleep(10);
};
const createUser = async (service: TestService, email: string) =>
  ((await (await service.fetch("/users", send({ email, name: email.split("@")[0] }))).json()) as { id: string }).id;

afterEach(() => setSystemTime());

test("a welcome request leads to one Outbox record, also when it is repeated", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const userId = await createUser(service, "ada@example.com");
    const first = (await (await service.fetch(`/users/${userId}/welcome`, send())).json()) as { id: string; deduplicated: boolean };
    await settle(async () => (await repos(service).queueMessages.findById(first.id))?.status === "completed");
    const again = (await (await service.fetch(`/users/${userId}/welcome`, send())).json()) as { id: string; deduplicated: boolean };
    expect(again).toEqual({ id: first.id, deduplicated: true });
    expect((await repos(service).outboxes.query().toArray()).map((sent) => [sent.to, sent.subject])).toEqual([["ada@example.com", "Welcome, ada!"]]);
  } finally {
    await service.stop();
  }
});

test("a failing address ends dead after its attempts and runs again with queues.retry", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const userId = await createUser(service, "bob@fail.test");
    const { id } = (await (await service.fetch(`/users/${userId}/welcome`, send())).json()) as { id: string };
    const message = () => repos(service).queueMessages.findById(id);
    // A clock moved past each retry delay: 10s, then 20s, each within 10%.
    let now = Date.now();
    for (const attempt of [1, 2]) {
      await settle(async () => (await message())?.attempt === attempt && (await message())?.status === "waiting");
      now += attempt * 12_000;
      setSystemTime(new Date(now));
    }
    await settle(async () => (await message())?.status === "dead");
    expect(await message()).toMatchObject({ status: "dead", attempt: 3, lastError: { message: "Mailbox bob@fail.test rejected the message" } });

    // The address is fixed, then the dead message is reprocessed.
    await service.fetch(`/users/${userId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bob@example.com" }) });
    await queues.retry(id);
    await settle(async () => (await message())?.status === "completed");
    expect(await message()).toMatchObject({ status: "completed", attempt: 1 });
    expect((await repos(service).outboxes.query().toArray()).map((sent) => sent.to)).toEqual(["bob@example.com"]);
  } finally {
    await service.stop();
  }
});

test("creating a user publishes user.created to the events queue, which queues/events.ts consumes", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    await createUser(service, "cy@example.com");
    const published = async () => (await repos(service).queueMessages.query().toArray()).filter((message) => message.queue === "events");
    await settle(async () => (await published()).some((message) => message.status === "completed"));
    expect((await published()).map((message) => [message.status, message.result])).toEqual([["completed", { type: "user.created" }]]);
  } finally {
    await service.stop();
  }
});

test("the project's queues/digest/notify.ts replaces the digest feature's queue", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const { id } = await queues.add("digest/notify", { userId: "u1" });
    await settle(async () => (await repos(service).queueMessages.findById(id))?.status === "completed");
    expect((await repos(service).queueMessages.findById(id))!.result).toEqual({ sentBy: "project" });
  } finally {
    await service.stop();
  }
});

test("the memory broker replaces the database broker", async () => {
  const files = exampleFiles();
  files["quickservicets.config.ts"] = files["quickservicets.config.ts"]!
    .replace('import { defineConfig, memoryAdapter } from "@quickservicets/core";', 'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nimport { memoryBroker } from "./memory-broker.ts";')
    .replace("queues: {", "queues: {\n    broker: memoryBroker(),");
  const service = await startTestService({ files });
  try {
    const userId = await createUser(service, "dee@example.com");
    await service.fetch(`/users/${userId}/welcome`, send());
    await settle(async () => (await repos(service).outboxes.query().toArray()).length === 1);
    expect(await repos(service).queueMessages.query().toArray()).toEqual([]);
  } finally {
    await service.stop();
  }
});
