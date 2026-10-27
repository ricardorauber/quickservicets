import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { entityModel, field } from "./entity-model.ts";
import { HttpError } from "./errors.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { events } from "./features/events/index.ts";
import type { AuthApi, AuthProvider } from "./features/auth/api.ts";
import { dummyPasswordCheck, identifierHash, invalidCredentials, loginGuard, memoryThrottleStore, repositoryThrottleStore } from "./features/auth/kit.ts";
import { sessionStore, tokenHashOf } from "./features/auth/sessions.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { configureTransactions } from "./transactions.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import type { EntityModel } from "./model.ts";

const MINUTE = 60_000;
const silent = { info() {}, warn() {}, error() {} };

const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

/** A guard on a fake clock. */
function fakeGuard(options: Parameters<typeof loginGuard>[0] = {}) {
  let at = Date.UTC(2030, 0, 1);
  const store = memoryThrottleStore(() => at);
  const guard = loginGuard({ store, now: () => at, logger: silent, ...options });
  return { guard, store, advance: (ms: number) => void (at += ms), now: () => at };
}

describe("lockout", () => {
  test("five failures lock an identifier for 1 minute, each further failure doubles it up to 1 hour, and success clears it", async () => {
    const { guard, advance } = fakeGuard();
    const attempt = { identifier: "Ana@X.co ", ip: "203.0.113.1" };
    for (let index = 0; index < 5; index++) {
      expect(await guard.check(attempt)).toEqual({ allowed: true });
      await guard.fail(attempt);
    }
    expect(await guard.check({ identifier: "ana@x.co", ip: "203.0.113.2" })).toEqual({ allowed: false, retryAfterMs: MINUTE });
    advance(MINUTE);
    expect((await guard.check(attempt)).allowed).toBe(true);
    await guard.fail(attempt);
    expect(await guard.check(attempt)).toEqual({ allowed: false, retryAfterMs: 2 * MINUTE });
    const locks: number[] = [];
    let lock = 2 * MINUTE;
    for (let index = 0; index < 8; index++) {
      advance(lock);
      await guard.fail(attempt);
      const result = await guard.check(attempt);
      lock = result.allowed ? 0 : result.retryAfterMs;
      locks.push(lock / MINUTE);
    }
    expect(locks).toEqual([4, 8, 16, 32, 60, 60, 60, 60]);
    await guard.succeed({ identifier: "ANA@x.co" });
    expect((await guard.check(attempt)).allowed).toBe(true);
  });

  test("failures older than the window are forgotten", async () => {
    const { guard, advance } = fakeGuard();
    const attempt = { identifier: "bob", ip: "203.0.113.1" };
    for (let index = 0; index < 4; index++) await guard.fail(attempt);
    advance(16 * MINUTE);
    await guard.fail(attempt);
    expect((await guard.check(attempt)).allowed).toBe(true);
  });
});

describe("identifiers and addresses", () => {
  test("identifiers are normalized and stored only as hashes", async () => {
    const { guard, store } = fakeGuard();
    await guard.fail({ identifier: "  Ｊoe@Example.COM ", ip: "203.0.113.1" });
    expect(identifierHash("  Ｊoe@Example.COM ")).toBe(identifierHash("joe@example.com"));
    expect(store.keys()).toEqual([`id:${identifierHash("joe@example.com")}`, "ip:203.0.113.1"]);
    expect(store.keys().join(" ")).not.toContain("joe");
  });

  test("50 failures from one address over different identifiers refuse the address, not another one", async () => {
    const { guard } = fakeGuard();
    for (let index = 0; index < 50; index++) await guard.fail({ identifier: `user${index}`, ip: "198.51.100.7" });
    expect((await guard.check({ identifier: "user50", ip: "198.51.100.7" })).allowed).toBe(false);
    expect((await guard.check({ identifier: "user50", ip: "198.51.100.8" })).allowed).toBe(true);
  });
});

describe("stores", () => {
  const counter = entityModel("LoginCounter", {
    key: field({ type: "string", unique: true }),
    failures: field({ type: "number" }),
    lockedUntil: field({ type: "date", optional: true }),
    expiresAt: field({ type: "date" }),
  });

  test("the repository store counts 20 concurrent failures across writers as 20 on SQLite", async () => {
    const adapter = sqliteAdapter({ path: join(mkdtempSync(join(tmpdir(), "qs-throttle-")), "data.db") });
    await adapter.connect([counter]);
    await createSqliteTables((adapter as unknown as { client: never }).client, [counter]);
    configureTransactions(adapter, silent);
    const repository = (createRepositories([counter], adapter) as unknown as Record<string, Repository>).loginCounters!;
    // Several guards stand for several replicas sharing the table.
    const guards = Array.from({ length: 4 }, () => loginGuard({ store: repositoryThrottleStore(repository), maxAttempts: 100, ipMaxAttempts: 1000, logger: silent }));
    await Promise.all(Array.from({ length: 20 }, (_, index) => guards[index % 4]!.fail({ identifier: "ana", ip: "203.0.113.9" })));
    const stored = await repository.findOne([{ field: "key", op: "eq", value: `id:${identifierHash("ana")}` }]);
    expect(stored?.failures).toBe(20);
    expect((await repository.findOne([{ field: "key", op: "eq", value: "ip:203.0.113.9" }]))?.failures).toBe(20);
    await adapter.disconnect();
  });
});

describe("uniform answers", () => {
  test("a locked existing and unknown account get byte-identical 429 answers with Retry-After", async () => {
    const accounts = new Map([["ana@example.com", await Bun.password.hash("right", { algorithm: "bcrypt", cost: 4 })]]);
    const { guard } = fakeGuard();
    const signIn = async (identifier: string, password: string): Promise<Response> => {
      try {
        await guard.assert({ identifier, ip: "203.0.113.1" });
        const hash = accounts.get(identifier);
        const ok = hash ? await Bun.password.verify(password, hash) : await dummyPasswordCheck(password);
        if (!ok) {
          await guard.fail({ identifier, ip: "203.0.113.1" });
          throw invalidCredentials();
        }
        return new Response("ok");
      } catch (error) {
        const failure = error as HttpError;
        return new Response(JSON.stringify({ error: { code: failure.code, message: failure.message } }), { status: failure.status, headers: failure.headers });
      }
    };
    for (const identifier of ["ana@example.com", "nobody@example.com"]) for (let index = 0; index < 5; index++) await signIn(identifier, "wrong");
    const existing = await signIn("ana@example.com", "right");
    const unknown = await signIn("nobody@example.com", "right");
    expect([existing.status, unknown.status]).toEqual([429, 429]);
    expect(existing.headers.get("retry-after")).toBe("60");
    expect(unknown.headers.get("retry-after")).toBe("60");
    expect(await existing.text()).toBe(await unknown.clone().text());
    expect(await unknown.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many attempts; try again later" } });
  });

  test("invalidCredentials is a 401 INVALID_CREDENTIALS, and a dummy check takes as long as a wrong password", async () => {
    const error = invalidCredentials();
    expect([error.status, error.code, error.message]).toEqual([401, "INVALID_CREDENTIALS", "Invalid credentials"]);
    const hash = await Bun.password.hash("right");
    await dummyPasswordCheck("warm-up");
    const median = async (work: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let index = 0; index < 20; index++) {
        const started = performance.now();
        await work();
        times.push(performance.now() - started);
      }
      return times.sort((a, b) => a - b)[10]!;
    };
    const wrong = await median(() => Bun.password.verify("wrong", hash));
    const unknown = await median(() => dummyPasswordCheck("wrong"));
    expect(Math.abs(unknown - wrong) / wrong).toBeLessThan(0.2);
  });
});

describe("revocation", () => {
  test("revoke calls every provider's revoke, runs onRevoke, emits auth.session.revoked and logs a failing provider", async () => {
    const revoked: string[] = [];
    const provider = (name: string, fail = false): AuthProvider => ({
      name,
      credentials: { headers: [`x-${name}`] },
      authenticate: () => null,
      revoke: (target) => {
        if (fail) throw new Error("store down");
        revoked.push(`${name}:${JSON.stringify(target)}`);
      },
    });
    let api: AuthApi | undefined;
    const callbacks: unknown[] = [];
    registerNative(
      defineFeature({
        key: "revoke-test",
        docs: { summary: "Registers providers." },
        enabledByDefault: true,
        requires: ["auth"],
        setup(ctx) {
          api = ctx.feature("auth");
          for (const each of [provider("one"), provider("broken", true), provider("two")]) api.provider(each);
          api.onRevoke((target) => void callbacks.push(target));
        },
      }),
    );
    registered.push("revoke-test");
    const app = await startTestApp({ config: { auth: {}, events: {} } });
    running.push(app);
    const emitted: unknown[] = [];
    const off = events.on("auth.session.revoked", (event) => void emitted.push(event.payload));
    try {
      await api!.revoke({ userId: "u1" });
    } finally {
      off();
    }
    expect(revoked).toEqual(['one:{"userId":"u1"}', 'two:{"userId":"u1"}']);
    expect(callbacks).toEqual([{ userId: "u1" }]);
    expect(emitted).toEqual([
      { userId: "u1", provider: "one" },
      { userId: "u1", provider: "two" },
    ]);
    expect(app.logs.find((entry) => entry.message === "auth.revoke.failed")).toMatchObject({ provider: "broken", error: { message: "store down" } });
    expect(() => api!.onRevoke(() => {})).toThrow("auth onRevoke() is only available during setup");
  });
});

describe("session store", () => {
  const session: EntityModel = entityModel("Session", {
    tokenHash: field({ type: "string", unique: true }),
    userId: field({ type: "string" }),
    expiresAt: field({ type: "date" }),
    idleExpiresAt: field({ type: "date", optional: true }),
    lastUsedAt: field({ type: "date" }),
    device: field({ type: "string", optional: true }),
  });

  async function sessions(options: { idle?: string; maxPerUser?: number } = {}) {
    const adapter = memoryAdapter();
    await adapter.connect([session]);
    configureTransactions(adapter, silent);
    const repository = (createRepositories([session], adapter) as unknown as Record<string, Repository>).sessions!;
    let reads = 0;
    const counted = { ...repository, findOne: (...args: Parameters<Repository["findOne"]>) => ((reads += 1), repository.findOne(...args)) } as Repository;
    let at = Date.now();
    const store = sessionStore({ entity: counted, tokenPrefix: "qs_sess_", expiresIn: "30d", now: () => at, ...options });
    return { store, repository, reads: () => reads, advance: (ms: number) => void (at += ms) };
  }

  test("create stores only the token's hash, and validate reads the database once per cache period", async () => {
    const { store, repository, reads, advance } = await sessions();
    const { token, session: created } = await store.create("u1", { device: "phone" });
    expect(token).toMatch(/^qs_sess_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ userId: "u1", device: "phone", tokenHash: tokenHashOf(token) });
    expect(JSON.stringify((await repository.list({ where: [], sort: [], limit: 10, offset: 0 })).data)).not.toContain(token);
    expect((await store.validate(token))?.id).toBe(created.id);
    advance(10_000);
    expect((await store.validate(token))?.id).toBe(created.id);
    expect(reads()).toBe(1);
    advance(30_000);
    await store.validate(token);
    expect(reads()).toBe(2);
    expect(await store.validate("qs_sess_unknown")).toBeNull();
    expect(await store.validate("other_prefix")).toBeNull();
  });

  test("idle and absolute expiries make a session null, and use extends the idle expiry at most once per hour", async () => {
    const idle = await sessions({ idle: "2h" });
    const { token } = await idle.store.create("u1");
    idle.advance(3 * 3_600_000);
    expect(await idle.store.validate(token)).toBeNull();
    const kept = await idle.store.create("u2");
    idle.advance(90 * 60_000);
    const used = await idle.store.validate(kept.token);
    expect(new Date(used!.idleExpiresAt!).getTime()).toBeGreaterThan(new Date(kept.session.idleExpiresAt!).getTime());
    idle.advance(90 * 60_000);
    expect(await idle.store.validate(kept.token)).not.toBeNull();
    const absolute = await sessions();
    const old = await absolute.store.create("u3");
    absolute.advance(31 * 86_400_000);
    expect(await absolute.store.validate(old.token)).toBeNull();
  });

  test("revoke by user invalidates every session at once, maxPerUser drops the oldest, and prune deletes long-expired ones", async () => {
    const { store, repository, advance } = await sessions({ maxPerUser: 2 });
    const first = await store.create("u1");
    advance(1000);
    const second = await store.create("u1");
    advance(1000);
    const third = await store.create("u1");
    expect(await store.validate(first.token)).toBeNull();
    expect(await store.validate(second.token)).not.toBeNull();
    expect(await store.revoke({ userId: "u1" })).toBe(2);
    expect(await store.validate(second.token)).toBeNull();
    expect(await store.validate(third.token)).toBeNull();
    const other = await store.create("u2");
    expect(await store.revoke({ sessionId: other.session.id })).toBe(1);
    const stale = await store.create("u3");
    const fresh = await store.create("u4");
    await repository.update(stale.session.id, { expiresAt: new Date(Date.now() - 2 * 86_400_000) });
    await repository.update(fresh.session.id, { expiresAt: new Date(Date.now() - 3_600_000) });
    advance(-2000);
    expect(await store.prune()).toBe(1);
    expect(await repository.findById(fresh.session.id)).not.toBeNull();
  });
});
