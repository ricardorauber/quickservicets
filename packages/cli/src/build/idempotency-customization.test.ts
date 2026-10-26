import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityModel } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => setSystemTime());

const HOUR = 3_600_000;
const config = (idempotency = "{}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { memoryIdempotencyStore } from "./memory-store.ts";
export default defineConfig({ database: memoryAdapter(), idempotency: ${idempotency}, users: {} });
void memoryIdempotencyStore;
`;
const USERS = `import { defineFeature } from "@quickservicets/core";
declare module "@quickservicets/core" {
  interface RequestUser { id: string; tenant?: string }
}
export default defineFeature({
  key: "users",
  middleware: [{ stage: "handler", run: (req, _res, next) => {
    const id = req.headers.get("x-user");
    if (id) req.user = { id, tenant: req.headers.get("x-tenant") ?? undefined };
    return next();
  } }],
});
`;
/** A store of the test project keeping keys in a Map, with the rules of the database store. */
const MEMORY_STORE = `import type { IdempotencyRecord, IdempotencyStore } from "@quickservicets/core";
export function memoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  return {
    async begin({ scope, fingerprint, ttlMs }) {
      const now = Date.now();
      const existing = records.get(scope);
      if (existing && existing.expiresAt.getTime() > now) {
        if (existing.fingerprint !== fingerprint) return { kind: "reused", record: existing };
        return { kind: existing.status === "done" ? "replay" : "inUse", record: existing };
      }
      const record: IdempotencyRecord = { id: crypto.randomUUID(), scope, fingerprint, status: "running", expiresAt: new Date(now + ttlMs), lockedUntil: new Date(now + 60_000) };
      records.set(scope, record);
      return { kind: "new", record };
    },
    async complete(record, response, ttlMs) {
      records.set(record.scope, { ...record, status: "done", response, expiresAt: new Date(Date.now() + ttlMs) });
    },
    async release(record) {
      records.delete(record.scope);
    },
    async cleanup() {
      return 0;
    },
  };
}
`;
const counter = (name: string) => `((globalThis as { runs?: Record<string, number> }).runs ??= {})[${JSON.stringify(name)}] = ((globalThis as { runs?: Record<string, number> }).runs![${JSON.stringify(name)}] ?? 0) + 1;`;
const files = (idempotency = "{}") => ({
  "quickservicets.config.ts": config(idempotency),
  "memory-store.ts": MEMORY_STORE,
  "features/users/index.ts": USERS,
  "entities/Order.ts": "/** @idempotent ttl=7d */\nexport type Order = { item: string };\n",
  "endpoints/notes/post.ts": `export default async () => {\n  ${counter("notes")}\n  return { ok: true };\n};\n`,
});
const g = globalThis as unknown as { runs?: Record<string, number>; conflicts?: string[] };
const runs = (name: string) => g.runs?.[name] ?? 0;
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const replayedOf = async (service: TestService, path: string, headers: Record<string, string>, body: unknown = {}) => (await service.fetch(path, post(body, headers))).headers.get("idempotent-replayed");

describe("variables and tags", () => {
  test("QS_IDEMPOTENCY_TTL, QS_IDEMPOTENCY_HEADER and QS_IDEMPOTENCY_ENABLED change the keys", async () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    g.runs = {};
    const short = await startTestService({ files: files(), env: { QS_IDEMPOTENCY_TTL: "1h", QS_IDEMPOTENCY_HEADER: "X-Request-Key" } });
    try {
      await short.fetch("/notes", post({}, { "x-request-key": "n1" }));
      expect(await replayedOf(short, "/notes", { "x-request-key": "n1" })).toBe("true");
      // The default header is not read any more.
      await short.fetch("/notes", post({}, { "idempotency-key": "n1" }));
      expect(runs("notes")).toBe(2);
      setSystemTime(new Date(now + HOUR + 1000));
      expect(await replayedOf(short, "/notes", { "x-request-key": "n1" })).toBeNull();
      expect(runs("notes")).toBe(3);
    } finally {
      await short.stop();
    }
    g.runs = {};
    // A tag of a disabled native fails the build, so this project has no @idempotent entity.
    const { "entities/Order.ts": _order, ...untagged } = files();
    const off = await startTestService({ files: untagged, env: { QS_IDEMPOTENCY_ENABLED: "false" } });
    try {
      for (let n = 0; n < 2; n++) await off.fetch("/notes", post({}, { "idempotency-key": "n1" }));
      expect(runs("notes")).toBe(2);
    } finally {
      await off.stop();
    }
  });

  test("@idempotent ttl=7d on Order keeps its keys 7 days, while other routes keep 24h", async () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    const service = await startTestService({ files: files() });
    try {
      await service.fetch("/orders", post({ item: "a" }, { "idempotency-key": "o1" }));
      await service.fetch("/notes", post({}, { "idempotency-key": "o1" }));
      setSystemTime(new Date(now + 48 * HOUR));
      expect(await replayedOf(service, "/orders", { "idempotency-key": "o1" }, { item: "a" })).toBe("true");
      expect(await replayedOf(service, "/notes", { "idempotency-key": "o1" })).toBeNull();
    } finally {
      await service.stop();
    }
  });
});

describe("per-request options", () => {
  test("a required function asks mobile clients only; a scope function lets one tenant's users share a key", async () => {
    g.runs = {};
    const service = await startTestService({
      files: files(`{ required: ({ req }) => req?.headers.get("x-client") === "mobile", scope: ({ user }) => user?.tenant ?? "anonymous" }`),
    });
    try {
      expect((await service.fetch("/notes", post({}, { "x-client": "mobile" }))).status).toBe(400);
      expect((await service.fetch("/notes", post({}, { "x-client": "web" }))).status).toBe(200);
      await service.fetch("/notes", post({}, { "idempotency-key": "t1", "x-user": "ana", "x-tenant": "acme" }));
      expect(await replayedOf(service, "/notes", { "idempotency-key": "t1", "x-user": "bob", "x-tenant": "acme" })).toBe("true");
      expect(await replayedOf(service, "/notes", { "idempotency-key": "t1", "x-user": "cy", "x-tenant": "other" })).toBeNull();
    } finally {
      await service.stop();
    }
  });
});

describe("hooks", () => {
  test("beforeReplay returning false runs the handler again; onConflict receives reused", async () => {
    g.runs = {};
    g.conflicts = [];
    const service = await startTestService({
      files: files(`{
    beforeReplay: (step) => (step && step.req.headers.get("x-fresh") ? false : undefined),
    onConflict: ({ kind }) => void (globalThis as { conflicts?: string[] }).conflicts!.push(kind),
  }`),
    });
    try {
      await service.fetch("/notes", post({ n: 1 }, { "idempotency-key": "h1" }));
      expect(await replayedOf(service, "/notes", { "idempotency-key": "h1" }, { n: 1 })).toBe("true");
      expect(await replayedOf(service, "/notes", { "idempotency-key": "h1", "x-fresh": "1" }, { n: 1 })).toBeNull();
      expect(runs("notes")).toBe(2);
      expect((await service.fetch("/notes", post({ n: 2 }, { "idempotency-key": "h1" }))).status).toBe(422);
      expect(g.conflicts).toEqual(["reused"]);
    } finally {
      await service.stop();
    }
  });
});

describe("the store", () => {
  test("a project store replays keys, and the build has no IdempotencyKey entity", async () => {
    g.runs = {};
    const service = await startTestService({ files: files("{ store: memoryIdempotencyStore() }") });
    try {
      await service.fetch("/notes", post({}, { "idempotency-key": "m1" }));
      expect(await replayedOf(service, "/notes", { "idempotency-key": "m1" })).toBe("true");
      expect(runs("notes")).toBe(1);
      expect((await service.fetch("/notes", post({ other: true }, { "idempotency-key": "m1" }))).status).toBe(422);
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.some((model) => model.key === "IdempotencyKey")).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

describe("reference", () => {
  test("the reference page lists @idempotent with required and ttl, the hooks and the store", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/idempotency.mdx"), "utf8");
    for (const text of ["@idempotent", "`required`", "`ttl`", "beforeReplay", "afterStore", "onConflict", "idempotency.store", "QS_IDEMPOTENCY_TTL"]) expect(page).toContain(text);
  });
});
