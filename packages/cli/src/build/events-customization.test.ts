import { afterEach, describe, expect, test } from "bun:test";
import { events, readOutbox, type AnyEvent } from "@quickservicets/core";
import { startTestService } from "../testing/service.ts";

type Seen = { seen?: string[]; published?: string[]; subscribed?: string[]; hooks?: string[] };
const g = globalThis as Seen;
afterEach(() => {
  g.seen = [];
  g.published = [];
  g.subscribed = [];
  g.hooks = [];
});

const config = (events: string) => `import { defineConfig, memoryAdapter, type AnyEvent } from "@quickservicets/core";
const g = globalThis as { seen?: string[]; published?: string[]; subscribed?: string[]; hooks?: string[] };
export default defineConfig({ database: memoryAdapter(), events: ${events} });
`;
const LOG = `import { listen } from "@quickservicets/core";
export default listen("*", (event) => void ((globalThis as { seen?: string[] }).seen ??= []).push(event.type));
`;
const USER = "export type User = { name: string; passwordHash?: string; lastSeenAt?: string };\n";
const post = (path: string, body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const start = (events: string, files: Record<string, string> = {}, env: Record<string, string> = {}) =>
  startTestService({ files: { "quickservicets.config.ts": config(events), "entities/User.ts": USER, "events/log.ts": LOG, ...files }, env });

describe("the @events tag and the defaults", () => {
  test("events: {} alone delivers user.created to a listener file", async () => {
    const service = await start("{}");
    try {
      await service.fetch("/users", post("/users", { name: "a" }));
      await events.idle();
      expect(g.seen).toEqual(["user.created"]);
    } finally {
      await service.stop();
    }
  });

  test("@events off silences an entity; @events outbox=false keeps its events out of the outbox", async () => {
    const service = await start("{ outbox: true }", {
      "entities/Session.ts": "/** @events off */\nexport type Session = { token: string };\n",
      "entities/Post.ts": "/** @events outbox=false */\nexport type Post = { title: string };\n",
    });
    try {
      await service.fetch("/sessions", post("/sessions", { token: "t" }));
      await service.fetch("/posts", post("/posts", { title: "p" }));
      await service.fetch("/users", post("/users", { name: "a" }));
      await events.idle();
      expect(g.seen).toEqual(["post.created", "user.created"]);
      expect((await readOutbox()).map((record) => record.type)).toEqual(["user.created"]);
    } finally {
      await service.stop();
    }
  });
});

describe("environment", () => {
  test("QS_EVENTS_OUTBOX_ENABLED turns the outbox on and QS_EVENTS_OUTBOX_EVENTS limits it", async () => {
    const service = await start("{}", { "entities/Order.ts": "export type Order = { item: string };\n" }, { QS_EVENTS_OUTBOX_ENABLED: "true", QS_EVENTS_OUTBOX_EVENTS: "order.*" });
    try {
      await service.fetch("/users", post("/users", { name: "a" }));
      await service.fetch("/orders", post("/orders", { item: "x" }));
      expect((await readOutbox()).map((record) => record.type)).toEqual(["order.created"]);
    } finally {
      await service.stop();
    }
  });
});

describe("hooks", () => {
  test("beforeEmit changes events for listeners and the outbox, drops some, and fails the write when it throws", async () => {
    const hooks = `{
  outbox: true,
  beforeEmit: (event: AnyEvent | null) => {
    if (!event || !("after" in event)) return;
    if (event.type === "user.updated" && event.changed.length === 1 && event.changed[0] === "lastSeenAt") return null;
    if ((event.after as { name?: string } | null)?.name === "boom") throw new Error("refused");
    if (event.after && "passwordHash" in event.after) {
      const { passwordHash: _hidden, ...after } = event.after as Record<string, unknown>;
      return { ...event, after } as AnyEvent;
    }
  },
}`;
    const service = await start(hooks);
    try {
      const recorded: AnyEvent[] = [];
      events.on("user.*", (event) => void recorded.push(event));
      const created = (await (await service.fetch("/users", post("/users", { name: "a", passwordHash: "secret" }))).json()) as { id: string };
      await service.fetch(`/users/${created.id}`, json("PATCH", { lastSeenAt: "now" }));
      await events.idle();
      expect(recorded.map((event) => event.type)).toEqual(["user.created"]);
      expect((recorded[0] as { after: Record<string, unknown> }).after).not.toHaveProperty("passwordHash");
      const [stored] = await readOutbox();
      expect((stored!.event as { after: Record<string, unknown> }).after).not.toHaveProperty("passwordHash");
      expect((await service.fetch("/users", post("/users", { name: "boom" }))).status).toBe(500);
      expect((await readOutbox()).map((record) => record.type)).toEqual(["user.created"]);
    } finally {
      await service.stop();
    }
  });

  test("a feature adds an afterEmit hook through the feature API, after the config's", async () => {
    const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "watcher",
  requires: ["events"],
  setup(ctx) {
    ctx.feature("events").addHook("afterEmit", (event) => void ((globalThis as { hooks?: string[] }).hooks ??= []).push("feature " + event.type));
  },
});
`;
    const service = await start(`{ afterEmit: (event: AnyEvent) => void (g.hooks ??= []).push("config " + event.type) }, watcher: {}`, { "features/watcher/index.ts": feature });
    try {
      await service.fetch("/users", post("/users", { name: "a" }));
      await events.idle();
      expect(g.hooks).toEqual(["config user.created", "feature user.created"]);
    } finally {
      await service.stop();
    }
  });
});

describe("a custom bus", () => {
  test("receives every event once, drives the after-commit listeners, and in-transaction listeners stay in the transaction", async () => {
    const bus = `{
  bus: {
    listeners: [] as { pattern: string; listener: (event: AnyEvent) => void }[],
    publish(event: AnyEvent) {
      (g.published ??= []).push(event.type);
      for (const { pattern, listener } of this.listeners) if (pattern === "*" || pattern === event.type) listener(event);
    },
    subscribe(pattern: string, listener: (event: AnyEvent) => void) {
      (g.subscribed ??= []).push(pattern);
      this.listeners.push({ pattern, listener });
    },
  },
}`;
    const service = await start(bus);
    try {
      const inside: string[] = [];
      events.on("user.created", () => {
        inside.push("in transaction");
        throw new Error("veto");
      }, { phase: "inTransaction" });
      expect((await service.fetch("/users", post("/users", { name: "a" }))).status).toBe(500);
      expect(inside).toEqual(["in transaction"]);
      expect(g.published ?? []).toEqual([]);
      const service2Events: string[] = [];
      events.on("user.updated", (event) => void service2Events.push(event.type));
      expect(g.subscribed).toEqual(["*", "user.updated"]);
    } finally {
      await service.stop();
    }
    const plain = await start(bus);
    try {
      await plain.fetch("/users", post("/users", { name: "a" }));
      expect(g.published).toEqual(["user.created"]);
      expect(g.seen).toEqual(["user.created"]);
    } finally {
      await plain.stop();
    }
  });
});
