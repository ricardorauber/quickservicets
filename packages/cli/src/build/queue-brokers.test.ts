import { afterEach, describe, expect, test } from "bun:test";
import { registerProjectFeatures } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

/** A broker of the test project: keeps what it receives in `globalThis.brokered`, defers transactional enqueues to the commit. */
const TEST_BROKER = `import { afterCommit, type QueueBroker, type QueueBrokerContext, type QueueBrokerMessage } from "@quickservicets/core";
export function memoryTestBroker(name = "memory-test"): QueueBroker {
  const received = (((globalThis as { brokered?: Record<string, QueueBrokerMessage[]> }).brokered ??= {})[name] = []);
  let ctx: QueueBrokerContext | undefined;
  const pending: { id: string; message: QueueBrokerMessage }[] = [];
  const deliver = (id: string, message: QueueBrokerMessage) => {
    if (!ctx) return void pending.push({ id, message });
    void ctx.handle({ id, queue: message.queue, payload: message.payload, attempt: 1, enqueuedAt: new Date() }, { signal: new AbortController().signal });
  };
  return {
    name,
    async enqueue(message, { transactional }) {
      const id = crypto.randomUUID();
      const publish = () => {
        received.push(message);
        deliver(id, message);
      };
      // This broker cannot join the database transaction, so it publishes once it commits.
      if (transactional) await afterCommit(publish);
      else publish();
      return { id, deduplicated: false };
    },
    start(context) {
      ctx = context;
      for (const entry of pending.splice(0)) deliver(entry.id, entry.message);
    },
    async stop() {
      ctx = undefined;
    },
    async stats() {
      return {};
    },
  };
}
`;
const CONSUMER = `import { queue } from "@quickservicets/core";
export default queue<{ to: string }>(({ payload }) => void ((globalThis as { consumed?: string[] }).consumed ??= []).push(payload.to));
`;
const ENDPOINTS = {
  "endpoints/send/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", (await req.json()) as { to: string });
`,
  "endpoints/in-transaction/post.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default async (repos: Repositories, req: ServiceRequest) => {
  const { fail, to } = (await req.json()) as { fail: boolean; to: string };
  try {
    await repos.transaction(async () => {
      await req.queue.add("send-email", { to });
      if (fail) throw new Error("rolled back");
    });
  } catch {
    return { rolledBack: true };
  }
  return { rolledBack: false };
};
`,
};
const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const g = globalThis as unknown as { brokered: Record<string, { queue: string; payload: { to?: string; type?: string } }[]>; consumed?: string[] };
const settle = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 300 && !check(); attempt++) await Bun.sleep(10);
};

describe("brokers", () => {
  test("a broker in queues.broker receives req.queue.add and @publish, and its handle runs the project's consumers", async () => {
    g.consumed = [];
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { memoryTestBroker } from "./test-broker.ts";
export default defineConfig({ database: memoryAdapter(), events: {}, queues: { broker: memoryTestBroker() } });
`,
        "test-broker.ts": TEST_BROKER,
        "entities/User.ts": "/** @publish queue=send-email */\nexport type User = { email: string };\n",
        "queues/send-email.ts": CONSUMER,
        ...ENDPOINTS,
      },
    });
    try {
      await service.fetch("/send", post({ to: "a@b.c" }));
      await service.fetch("/users", post({ email: "d@e.f" }));
      await settle(() => (g.consumed ?? []).length >= 2);
      expect(g.brokered["memory-test"]!.map((message) => message.payload.to ?? message.payload.type)).toEqual(["a@b.c", "user.created"]);
      expect(g.consumed![0]).toBe("a@b.c");
      // Nothing went to the database broker.
      expect(await (service.repos as unknown as { queueMessages: { query(): { toArray(): Promise<unknown[]> } } }).queueMessages.query().toArray()).toEqual([]);
    } finally {
      await service.stop();
    }
  });

  test("a broker that cannot join the transaction receives nothing for a rolled-back add, and the message after a commit", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { memoryTestBroker } from "./test-broker.ts";
export default defineConfig({ database: memoryAdapter(), queues: { broker: memoryTestBroker("deferring") } });
`,
        "test-broker.ts": TEST_BROKER,
        "queues/send-email.ts": CONSUMER,
        ...ENDPOINTS,
      },
    });
    try {
      expect(await (await service.fetch("/in-transaction", post({ fail: true, to: "x@y.z" }))).json()).toEqual({ rolledBack: true });
      expect(g.brokered.deferring).toEqual([]);
      expect(await (await service.fetch("/in-transaction", post({ fail: false, to: "ok@y.z" }))).json()).toEqual({ rolledBack: false });
      expect(g.brokered.deferring!.map((message) => message.payload.to)).toEqual(["ok@y.z"]);
    } finally {
      await service.stop();
    }
  });

  test("queues.broker without start fails naming the missing method", async () => {
    await expect(
      startTestService({
        files: { "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), queues: { broker: { enqueue() {} } as never } });\n` },
      }),
    ).rejects.toThrow(/Invalid queues\.broker: .*start/);
  });
});

const FEATURE = (key: string) => `import { defineFeature } from "@quickservicets/core";
import { memoryTestBroker } from "../../test-broker.ts";
export default defineFeature({
  key: "${key}",
  after: ["queues"],
  setup(ctx) {
    ctx.feature("queues").setBroker(memoryTestBroker("${key}"));
  },
});
`;

describe("setBroker", () => {
  test("a project feature's setBroker replaces the database broker", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), queues: {}, rabbit: {} });\n`,
        "test-broker.ts": TEST_BROKER,
        "features/rabbit/index.ts": FEATURE("rabbit"),
        "queues/send-email.ts": CONSUMER,
        ...ENDPOINTS,
      },
    });
    try {
      await service.fetch("/send", post({ to: "rabbit@b.c" }));
      expect(g.brokered.rabbit!.map((message) => message.payload.to)).toEqual(["rabbit@b.c"]);
    } finally {
      await service.stop();
    }
  });

  test("two features setting a broker, or one with queues.broker configured, fail naming both", async () => {
    const files = {
      "test-broker.ts": TEST_BROKER,
      "features/rabbit/index.ts": FEATURE("rabbit"),
      "features/kafka/index.ts": FEATURE("kafka"),
      "queues/send-email.ts": CONSUMER,
    };
    await expect(
      startTestService({ files: { ...files, "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), queues: {}, rabbit: {}, kafka: {} });\n` } }),
    ).rejects.toThrow("Queue broker set by kafka and rabbit; keep one");
    await expect(
      startTestService({
        files: {
          ...files,
          "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nimport { memoryTestBroker } from "./test-broker.ts";\nexport default defineConfig({ database: memoryAdapter(), queues: { broker: memoryTestBroker() }, rabbit: {} });\n`,
        },
      }),
    ).rejects.toThrow("Queue broker set by queues.broker and rabbit; keep one");
  });
});

describe("optional methods", () => {
  test("queue dead with a broker without dead exits 1 naming the broker and the method", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { memoryTestBroker } from "./test-broker.ts";
export default defineConfig({ database: memoryAdapter(), queues: { broker: memoryTestBroker("partial") }, logger: { info() {}, warn() {}, error() {} } });
`,
      "test-broker.ts": TEST_BROKER,
      "queues/send-email.ts": CONSUMER,
    });
    await build(root);
    const err: string[] = [];
    const code = await run(["queue", "dead", "send-email"], { log: () => {}, error: (line) => err.push(line) }, root);
    expect({ code, err }).toEqual({ code: 1, err: ["The partial queue broker does not support dead"] });
    const retry = await run(["queue", "retry", "--queue", "send-email", "--dead"], { log: () => {}, error: (line) => err.push(line) }, root);
    expect(retry).toBe(1);
    expect(err.at(-1)).toBe("The partial queue broker does not support retryDead");
  });

  test("queues.retry with a broker without retry rejects naming the method", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nimport { memoryTestBroker } from "./test-broker.ts";\nexport default defineConfig({ database: memoryAdapter(), queues: { broker: memoryTestBroker("plain") } });\n`,
        "test-broker.ts": TEST_BROKER,
        "queues/send-email.ts": CONSUMER,
        "endpoints/retry/post.ts": `import { queues } from "@quickservicets/core";
export default async () => {
  try {
    await queues.retry("x");
  } catch (error) {
    return { error: (error as Error).message };
  }
};
`,
      },
    });
    try {
      expect(await (await service.fetch("/retry", post())).json()).toEqual({ error: "The plain queue broker does not support retry" });
    } finally {
      await service.stop();
    }
  });
});
