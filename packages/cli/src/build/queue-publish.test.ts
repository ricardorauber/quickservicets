import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { registerProjectFeatures, type EntityModel } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const config = (keys = "events: {}, queues: { consume: false }") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;
const EVENTS_QUEUE = `import { queue, type QueuePayloads } from "@quickservicets/core";
export default queue<QueuePayloads["events"]>(({ payload }) => payload.type);
`;
const send = (method: string, body: unknown = {}) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { queue: string; payload: { id: string; type: string; cause: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed: string[] }; dedupeKey: string };
type Repos = { queueMessages: { query(): { toArray(): Promise<Message[]> } } };
const messages = async (service: TestService) => (await (service.repos as unknown as Repos).queueMessages.query().toArray()).sort((a, b) => a.payload.id.localeCompare(b.payload.id));

describe("the @publish tag", () => {
  test("@publish created,updated sends creates and updates to the events queue, not deletes; @publish off sends nothing", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(),
        "entities/User.ts": "/** @publish created,updated */\nexport type User = { email: string };\n",
        "entities/Note.ts": "/** @publish off */\nexport type Note = { text: string };\n",
        "queues/events.ts": EVENTS_QUEUE,
      },
    });
    try {
      const user = (await (await service.fetch("/users", send("POST", { email: "a@b.c" }))).json()) as { id: string };
      await service.fetch(`/users/${user.id}`, send("PATCH", { email: "d@e.f" }));
      await service.fetch(`/users/${user.id}`, { method: "DELETE" });
      await service.fetch("/notes", send("POST", { text: "x" }));
      const found = await messages(service);
      expect(found.map((message) => [message.queue, message.payload.type])).toEqual([
        ["events", "user.created"],
        ["events", "user.updated"],
      ]);
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((model) => model.key === "User")!.tags?.publish).toEqual({ on: true, options: { events: ["created", "updated"] } });
    } finally {
      await service.stop();
    }
  });

  test("the consumer of the events queue receives the published events", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config("events: {}, queues: {}"),
        "entities/User.ts": "/** @publish */\nexport type User = { email: string };\n",
        "queues/events.ts": `import { queue, type QueuePayloads } from "@quickservicets/core";
const received = ((globalThis as { received?: string[] }).received = []);
export default queue<QueuePayloads["events"]>(({ payload }) => void received.push(payload.type));
`,
      },
    });
    try {
      const user = (await (await service.fetch("/users", send("POST", { email: "a@b.c" }))).json()) as { id: string };
      await service.fetch(`/users/${user.id}`, send("PATCH", { email: "d@e.f" }));
      const received = () => (globalThis as unknown as { received: string[] }).received;
      for (let attempt = 0; attempt < 300 && received().length < 2; attempt++) await Bun.sleep(10);
      expect(received()).toEqual(["user.created", "user.updated"]);
    } finally {
      await service.stop();
    }
  });

  test("queue=crm-sync sends to that queue", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(),
        "entities/User.ts": "/** @publish queue=crm-sync */\nexport type User = { email: string };\n",
        "queues/crm-sync.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => {});\n',
      },
    });
    try {
      await service.fetch("/users", send("POST", { email: "a@b.c" }));
      expect((await messages(service)).map((message) => message.queue)).toEqual(["crm-sync"]);
    } finally {
      await service.stop();
    }
  });
});

describe("requirements and build checks", () => {
  test("without events, startup fails naming @publish", async () => {
    await expect(
      startTestService({ files: { "quickservicets.config.ts": config("queues: {}"), "entities/User.ts": "/** @publish */\nexport type User = { email: string };\n" } }),
    ).rejects.toThrow("queues requires events; add events: {} to quickservicets.config.ts (@publish on User sends write events)");
  });

  test("an unknown field fails the build; a target queue without a consumer is a warning", async () => {
    const broken = createLinkedProject({ "quickservicets.config.ts": config(), "entities/User.ts": "/** @publish fields=nope */\nexport type User = { email: string };\n" });
    await expect(build(broken)).rejects.toThrow("entities/User.ts: invalid @publish: unknown field nope");
    const unconsumed = createLinkedProject({ "quickservicets.config.ts": config(), "entities/User.ts": "/** @publish queue=crm-sync */\nexport type User = { email: string };\n" });
    const summary = await build(unconsumed);
    expect(summary.warnings).toContain("@publish on User sends to queue crm-sync, which has no consumer in queues/ and no broker");
  });
});

describe("transactions and cascades", () => {
  test("a write rolled back after the listener ran leaves no message; a cascade publishes each deleted user", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(),
        "entities/Organization.ts": "export type Organization = { name: string };\n",
        "entities/User.ts": 'import type { Organization } from "./Organization.ts";\n/** @publish */\nexport type User = {\n  email: string;\n  /** @onDelete cascade */\n  organization?: Organization;\n};\n',
        "queues/events.ts": EVENTS_QUEUE,
        "endpoints/failing/post.ts": `import type { Repositories } from "@quickservicets/core";
export default async (repos: Repositories) => {
  try {
    await repos.transaction(async () => {
      await (repos as unknown as { users: { create(data: object): Promise<unknown> } }).users.create({ email: "x@y.z" });
      throw new Error("after the write");
    });
  } catch {
    return { rolledBack: true };
  }
};
`,
      },
    });
    try {
      expect(await (await service.fetch("/failing", send("POST"))).json()).toEqual({ rolledBack: true });
      expect(await messages(service)).toEqual([]);
      const organization = (await (await service.fetch("/organizations", send("POST", { name: "Acme" }))).json()) as { id: string };
      for (const email of ["a@b.c", "d@e.f"]) await service.fetch("/users", send("POST", { email, organization: organization.id }));
      await service.fetch(`/organizations/${organization.id}`, { method: "DELETE" });
      const deleted = (await messages(service)).filter((message) => message.payload.type === "user.deleted");
      expect(deleted.map((message) => message.payload.cause)).toEqual(["cascade", "cascade"]);
    } finally {
      await service.stop();
    }
  });
});

describe("payloads", () => {
  test("hidden fields are left out, fields keeps only the listed ones and id, and the dedupe key is the event id", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(),
        "entities/User.ts": "/** @publish */\nexport type User = {\n  email: string;\n  /** @hidden */\n  passwordHash: string;\n  name: string;\n};\n",
        "entities/Contact.ts": "/** @publish fields=email */\nexport type Contact = { email: string; phone: string };\n",
        "queues/events.ts": EVENTS_QUEUE,
      },
    });
    try {
      await service.fetch("/users", send("POST", { email: "a@b.c", passwordHash: "secret", name: "Ada" }));
      await service.fetch("/contacts", send("POST", { email: "c@d.e", phone: "123" }));
      const [user, contact] = await messages(service);
      expect(Object.keys(user!.payload.after!).sort()).toEqual(["createdAt", "email", "id", "name", "updatedAt"]);
      expect(user!.payload.before).toBeNull();
      expect(contact!.payload.after).toEqual({ id: expect.any(String), email: "c@d.e" });
      expect(user!.dedupeKey).toBe(user!.payload.id);
      expect(contact!.dedupeKey).toBe(contact!.payload.id);
    } finally {
      await service.stop();
    }
  });

  test("a project without @publish registers no write listener", async () => {
    const service = await startTestService({
      files: { "quickservicets.config.ts": config(), "entities/User.ts": "export type User = { email: string };\n", "queues/events.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => {});\n' },
    });
    try {
      const state = (globalThis as unknown as Record<symbol, { bus: { inTransaction: unknown[] } }>)[Symbol.for("quickservicets.events.state")]!;
      expect(state.bus.inTransaction).toEqual([]);
      await service.fetch("/users", send("POST", { email: "a@b.c" }));
      expect(await messages(service)).toEqual([]);
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
  test("QueuePayloads types a publish target with the write events of the entities publishing to it", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": config(),
      "entities/User.ts": "/** @publish created,updated */\nexport type User = { email: string };\n",
      "queues/events.ts": EVENTS_QUEUE,
    });
    await build(root);
    expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).toContain('"events": EventMap["user.created"] | EventMap["user.updated"];');
    const source = `import "./.generated/types.ts";
import { queue, type QueuePayloads } from "@quickservicets/core";
export default queue<QueuePayloads["events"]>(({ payload }) => {
  const email: string = payload.after.email;
  // @ts-expect-error User has no name
  payload.after.name;
  return email;
});
`;
    expect(typeErrors(root, source)).toEqual([]);
  });
});
