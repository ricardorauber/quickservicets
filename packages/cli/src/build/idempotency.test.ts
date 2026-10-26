import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => setSystemTime());

const config = (idempotency = "{}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), idempotency: ${idempotency}, users: {} });
`;
/** A project feature that sets req.user from the x-user header, as an auth middleware would. */
const USERS = `import { defineFeature } from "@quickservicets/core";
declare module "@quickservicets/core" {
  interface RequestUser { id: string }
}
export default defineFeature({
  key: "users",
  middleware: [{ stage: "handler", run: (req, _res, next) => {
    const id = req.headers.get("x-user");
    if (id) req.user = { id };
    return next();
  } }],
});
`;
const g = globalThis as unknown as { runs?: Record<string, number> };
const counting = (name: string) => `((globalThis as { runs?: Record<string, number> }).runs ??= {})[${JSON.stringify(name)}] = (((globalThis as { runs?: Record<string, number> }).runs ?? {})[${JSON.stringify(name)}] ?? 0) + 1;`;
const FILES = {
  "quickservicets.config.ts": config(),
  "features/users/index.ts": USERS,
  "entities/Order.ts": "export type Order = { item: string; quantity: number };\n",
  "entities/Ticket.ts": "/** @idempotent required=true */\nexport type Ticket = { title: string };\n",
  "entities/Note.ts": "/** @idempotent off */\nexport type Note = { text: string };\n",
  "endpoints/orders/post.ts": `import type { Repositories, ServiceRequest, ServiceResponse } from "@quickservicets/core";
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  ${counting("orders")}
  const order = await (repos as unknown as { orders: { create(data: object): Promise<{ id: string }> } }).orders.create((await req.json()) as object);
  res.status(201).header("location", \`/orders/\${order.id}\`);
  return order;
};
`,
  "endpoints/slow/post.ts": `export default async () => {
  ${counting("slow")}
  await Bun.sleep(300);
  return { done: true };
};
`,
  "endpoints/failing/post.ts": `import { HttpError, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => {
  ${counting("failing")}
  const { mode } = (await req.json()) as { mode: string };
  if (mode === "crash") throw new Error("boom");
  if (mode === "invalid") throw new HttpError(400, "Quantity must be positive");
  return { ok: true };
};
`,
  "endpoints/big/post.ts": `export default async () => {
  ${counting("big")}
  return { blob: "x".repeat(2 * 1024 * 1024) };
};
`,
  "endpoints/items/[id]/put.ts": `/** @idempotent */
export default async (_repos: unknown, req: { params: Record<string, string> }) => {
  ${counting("put")}
  return { id: req.params.id };
};
`,
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
type Repos = { orders: { query(): { all(): Promise<unknown[]> } }; idempotencyKeys: { query(): { all(): Promise<{ status: string }[]> } } };
const repos = (service: TestService) => service.repos as unknown as Repos;
const runs = (name: string) => g.runs?.[name] ?? 0;

describe("replays", () => {
  test("a repeated POST with one key creates one order and replays the status, body and location", async () => {
    g.runs = {};
    const service = await startTestService({ files: FILES });
    try {
      const first = await service.fetch("/orders", post("/orders", { item: "book", quantity: 1 }, { "idempotency-key": "k1" }));
      const second = await service.fetch("/orders", post("/orders", { item: "book", quantity: 1 }, { "idempotency-key": "k1" }));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      expect(first.headers.get("idempotent-replayed")).toBeNull();
      expect(second.headers.get("location")).toBe(first.headers.get("location"));
      expect(await second.json()).toEqual(await first.json());
      expect(await repos(service).orders.query().all()).toHaveLength(1);
      expect(runs("orders")).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

describe("headers and tags", () => {
  test("an invalid key is 400; a required key is 400 when missing; @idempotent off ignores keys", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const long = await service.fetch("/orders", post("/orders", { item: "a", quantity: 1 }, { "idempotency-key": "k".repeat(300) }));
      expect([long.status, ((await long.json()) as { error: { code: string; message: string } }).error]).toEqual([400, { code: "VALIDATION_ERROR", message: "Invalid Idempotency-Key header" }]);
      const missing = await service.fetch("/tickets", post("/tickets", { title: "t" }));
      expect([missing.status, ((await missing.json()) as { error: { message: string } }).error.message]).toEqual([400, "Idempotency-Key header is required"]);
      expect((await service.fetch("/tickets", post("/tickets", { title: "t" }, { "idempotency-key": "t1" }))).status).toBe(201);
      for (let n = 0; n < 2; n++) {
        const note = await service.fetch("/notes", post("/notes", { text: "same" }, { "idempotency-key": "n1" }));
        expect([note.status, note.headers.get("idempotent-replayed")]).toEqual([201, null]);
      }
      // Without the header, a request runs normally.
      expect((await service.fetch("/orders", post("/orders", { item: "b", quantity: 1 }))).status).toBe(201);
    } finally {
      await service.stop();
    }
  });

  test("@idempotent on a PUT endpoint applies to it", async () => {
    g.runs = {};
    const service = await startTestService({ files: FILES });
    try {
      for (let n = 0; n < 2; n++) await service.fetch("/items/i1", { method: "PUT", headers: { "idempotency-key": "p1" } });
      expect(runs("put")).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

describe("scope and fingerprint", () => {
  test("the same key with another body is 422; two users with one key each create an order", async () => {
    const service = await startTestService({ files: FILES });
    try {
      await service.fetch("/orders", post("/orders", { item: "a", quantity: 1 }, { "idempotency-key": "k1", "x-user": "ana" }));
      const reused = await service.fetch("/orders", post("/orders", { item: "a", quantity: 2 }, { "idempotency-key": "k1", "x-user": "ana" }));
      expect([reused.status, ((await reused.json()) as { error: { code: string; message: string } }).error]).toEqual([
        422,
        { code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency-Key was used with a different request" },
      ]);
      const other = await service.fetch("/orders", post("/orders", { item: "a", quantity: 1 }, { "idempotency-key": "k1", "x-user": "bob" }));
      expect([other.status, other.headers.get("idempotent-replayed")]).toEqual([201, null]);
      expect(await repos(service).orders.query().all()).toHaveLength(2);
    } finally {
      await service.stop();
    }
  });
});

describe("concurrency", () => {
  test("two concurrent requests with one key run the handler once; the other is 409 with Retry-After", async () => {
    g.runs = {};
    const service = await startTestService({ files: FILES });
    try {
      const [a, b] = await Promise.all([service.fetch("/slow", post("/slow", {}, { "idempotency-key": "s1" })), service.fetch("/slow", post("/slow", {}, { "idempotency-key": "s1" }))]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const conflict = a.status === 409 ? a : b;
      expect(conflict.headers.get("retry-after")).toBe("1");
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_IN_USE");
      expect(runs("slow")).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

describe("stored and released results", () => {
  test("a 500 releases the key and a retry runs again; a 400 is replayed; a 2 MB response is not stored", async () => {
    g.runs = {};
    const service = await startTestService({ files: FILES });
    try {
      expect((await service.fetch("/failing", post("/failing", { mode: "crash" }, { "idempotency-key": "f1" }))).status).toBe(500);
      expect((await service.fetch("/failing", post("/failing", { mode: "crash" }, { "idempotency-key": "f1" }))).status).toBe(500);
      expect(runs("failing")).toBe(2);
      const invalid = await service.fetch("/failing", post("/failing", { mode: "invalid" }, { "idempotency-key": "f2" }));
      const replayedInvalid = await service.fetch("/failing", post("/failing", { mode: "invalid" }, { "idempotency-key": "f2" }));
      expect([invalid.status, replayedInvalid.status, replayedInvalid.headers.get("idempotent-replayed")]).toEqual([400, 400, "true"]);
      expect(await replayedInvalid.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "Quantity must be positive" } });
      expect(runs("failing")).toBe(3);
      for (let n = 0; n < 2; n++) expect((await service.fetch("/big", post("/big", {}, { "idempotency-key": "b1" }))).status).toBe(200);
      expect(runs("big")).toBe(2);
    } finally {
      await service.stop();
    }
  });
});

describe("expiry", () => {
  test("a key replays at 23h and runs again at 25h", async () => {
    g.runs = {};
    const now = Date.now();
    setSystemTime(new Date(now));
    const service = await startTestService({ files: FILES });
    try {
      const body = { item: "a", quantity: 1 };
      await service.fetch("/orders", post("/orders", body, { "idempotency-key": "e1" }));
      setSystemTime(new Date(now + 23 * 3_600_000));
      expect((await service.fetch("/orders", post("/orders", body, { "idempotency-key": "e1" }))).headers.get("idempotent-replayed")).toBe("true");
      setSystemTime(new Date(now + 25 * 3_600_000));
      const again = await service.fetch("/orders", post("/orders", body, { "idempotency-key": "e1" }));
      expect([again.status, again.headers.get("idempotent-replayed")]).toEqual([201, null]);
      expect(runs("orders")).toBe(2);
    } finally {
      await service.stop();
    }
  });
});
