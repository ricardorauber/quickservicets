import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteAdapter, type EntityModel, type StoredRecord } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

const DAY = 86_400_000;
const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).historyLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).historyLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).historyLogs ??= []).push(entry),
  }`;
const config = (history: string, extra = "") => `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), events: {}, history: ${history}, ${LOGGER}${extra ? `, ${extra}` : ""} });
`;
const ENTITIES = {
  "entities/User.ts": "/** @history */\nexport type User = { name: string; email?: string };\n",
  "entities/Session.ts": "/** @history retention=7d */\nexport type Session = { token: string };\n",
};
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Version = { entityId: string; version?: number; operation: string; record: Record<string, unknown>; tenant?: string };
const logs = () => ((globalThis as { historyLogs?: { message: string; hook?: string }[] }).historyLogs ??= []);
afterEach(() => {
  logs().length = 0;
});
const create = async (service: TestService, body: unknown = { name: "Ada", email: "ada@x.io" }) => ((await (await service.fetch("/users", send("POST", body))).json()) as { id: string }).id;
const versionsOf = async (service: TestService, id: string) =>
  ((await (service.repos as unknown as Record<string, { query(): { toArray(): Promise<Version[]> } }>).userHistory!.query().toArray()) as Version[])
    .filter((version) => version.entityId === id)
    .sort((a, b) => a.version! - b.version!);
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

/** A migrated SQLite project, a way to store versions of a given age and tenant, and the CLI. */
async function sqliteProject(history: string) {
  const root = createLinkedProject({ "quickservicets.config.ts": "", ...ENTITIES });
  const path = join(root, "data.db");
  writeFileSync(
    join(root, "quickservicets.config.ts"),
    `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), events: {}, history: ${history}, logger: { info() {}, warn() {}, error() {} } });\n`,
  );
  await build(root);
  await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 15, 12)));
  await migrate(root);
  const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
  const withAdapter = async <T>(fn: (adapter: ReturnType<typeof sqliteAdapter>) => Promise<T>) => {
    const adapter = sqliteAdapter({ path });
    await adapter.connect(models);
    try {
      return await fn(adapter);
    } finally {
      await adapter.disconnect();
    }
  };
  const modelOf = (key: string) => models.find((model) => model.key === key)!;
  const insert = (key: string, entityId: string, version: number, ageDays: number, tenant?: string) =>
    withAdapter(async (adapter) => {
      const at = new Date(Date.now() - ageDays * DAY);
      await adapter.insert(modelOf(key), { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, entityId, version, operation: "update", actor: "system", at, record: {}, changed: [], ...(tenant ? { tenant } : {}) } as StoredRecord);
    });
  const count = (key: string) => withAdapter((adapter) => adapter.count(modelOf(key), []));
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  return { root, insert, count, cli };
}

describe("options, variables and tags", () => {
  test("QS_HISTORY_RETENTION sets the retention, and QS_HISTORY_ENABLED=false starts without routes or listeners", async () => {
    const { insert, count, cli } = await sqliteProject("{}");
    await insert("UserHistory", "a", 1, 3);
    await insert("UserHistory", "a", 2, 0);
    process.env.QS_HISTORY_RETENTION = "1d";
    try {
      expect((await cli("history", "prune", "--entity", "User")).out).toEqual(["User: 1 versions deleted"]);
    } finally {
      delete process.env.QS_HISTORY_RETENTION;
    }
    expect(await count("UserHistory")).toBe(1);
    const plain = { "entities/User.ts": "export type User = { name: string };\n" };
    const off = await startTestService({ files: { "quickservicets.config.ts": config('{ entities: "all" }'), ...plain }, env: { QS_HISTORY_ENABLED: "false" } });
    try {
      const id = await create(off);
      expect((await off.fetch(`/users/${id}/history`)).status).toBe(404);
      expect((off.repos as Record<string, unknown>).userHistory).toBeUndefined();
    } finally {
      await off.stop();
    }
  });

  test("@history retention=7d wins over the global retention for its entity; other options fail the build", async () => {
    const { insert, count, cli } = await sqliteProject('{ retention: "365d" }');
    await insert("SessionHistory", "s", 1, 8);
    await insert("SessionHistory", "s", 2, 1);
    await insert("UserHistory", "u", 1, 8);
    await insert("UserHistory", "u", 2, 1);
    expect((await cli("history", "prune")).out).toEqual(["Session: 1 versions deleted", "User: 0 versions deleted"]);
    expect([await count("SessionHistory"), await count("UserHistory")]).toEqual([1, 2]);
    const keep = createLinkedProject({ "quickservicets.config.ts": config("{}"), ...ENTITIES, "entities/Note.ts": "/** @history keep=1 */\nexport type Note = { text: string };\n" });
    expect((await failure(() => build(keep))).message).toContain("entities/Note.ts: invalid @history: unknown option keep");
    const field = createLinkedProject({ "quickservicets.config.ts": config("{}"), ...ENTITIES, "entities/Note.ts": "export type Note = {\n  /** @history retention=7d */\n  text: string;\n};\n" });
    expect((await failure(() => build(field))).message).toContain("entities/Note.ts: invalid @history: takes no options, got retention");
  });

  test("a retention function decides per tenant; versions without a tenant get undefined; an invalid result fails naming history.retention", async () => {
    const { insert, count, cli } = await sqliteProject('{ retention: ({ tenant }) => (tenant === "pro" ? "1825d" : tenant === undefined ? undefined : "90d") }');
    await insert("UserHistory", "p", 1, 100, "pro");
    await insert("UserHistory", "p", 2, 1, "pro");
    await insert("UserHistory", "f", 1, 100, "free");
    await insert("UserHistory", "f", 2, 1, "free");
    await insert("UserHistory", "n", 1, 100);
    await insert("UserHistory", "n", 2, 1);
    expect((await cli("history", "prune", "--entity", "User")).out).toEqual(["User: 1 versions deleted"]);
    expect(await count("UserHistory")).toBe(5);
    const invalid = await sqliteProject('{ retention: () => "soon" }');
    await invalid.insert("UserHistory", "a", 1, 100);
    const failed = await invalid.cli("history", "prune");
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toContain("history.retention");
  });
});

describe("hooks and the feature API", () => {
  test("beforeVersion masks, skips and fails writes; a failing afterVersion is logged", async () => {
    const masking = await startTestService({
      files: { "quickservicets.config.ts": config('{ beforeVersion: (step) => step && { ...step, version: { ...step.version, record: { ...step.version.record, email: "[masked]" } } } }'), ...ENTITIES },
    });
    try {
      const id = await create(masking);
      expect((await versionsOf(masking, id))[0]!.record.email).toBe("[masked]");
    } finally {
      await masking.stop();
    }
    const skipping = await startTestService({ files: { "quickservicets.config.ts": config('{ beforeVersion: (step) => (step?.version.operation === "update" ? null : undefined) }'), ...ENTITIES } });
    try {
      const id = await create(skipping);
      await skipping.fetch(`/users/${id}`, send("PATCH", { name: "B" }));
      await skipping.fetch(`/users/${id}`, { method: "DELETE" });
      expect((await versionsOf(skipping, id)).map((version) => version.operation)).toEqual(["create", "delete"]);
    } finally {
      await skipping.stop();
    }
    const throwing = await startTestService({
      files: { "quickservicets.config.ts": config('{ beforeVersion: (step) => { if (step?.version.operation === "update") throw new Error("no history"); }, afterVersion: () => { throw new Error("after failed"); } }'), ...ENTITIES },
    });
    try {
      const id = await create(throwing);
      expect(logs().some((entry) => entry.message === "feature.hook.failed" && entry.hook === "afterVersion")).toBe(true);
      expect((await throwing.fetch(`/users/${id}`, send("PATCH", { name: "B" }))).status).toBe(500);
      expect(((await (await throwing.fetch(`/users/${id}`)).json()) as { name: string }).name).toBe("Ada");
    } finally {
      await throwing.stop();
    }
  });

  test("a project feature adds a beforeVersion hook after the config's and reads versions through the API", async () => {
    const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "audit",
  requires: ["history"],
  setup(ctx) {
    const history = ctx.feature("history");
    history.beforeVersion((step) => step && { ...step, version: { ...step.version, record: { ...step.version.record, order: [...((step.version.record.order as string[]) ?? []), "feature"] } } });
    (globalThis as any).historyApi = history;
  },
});
`;
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config('{ beforeVersion: (step) => step && { ...step, version: { ...step.version, record: { ...step.version.record, order: ["config"] } } } }', "audit: {}"),
        "features/audit/index.ts": feature,
        ...ENTITIES,
      },
    });
    try {
      const id = await create(service);
      await service.fetch(`/users/${id}`, send("PATCH", { name: "B" }));
      expect((await versionsOf(service, id))[0]!.record.order).toEqual(["config", "feature"]);
      const latest = await (globalThis as { historyApi?: { versions(entity: string, id: string, page: object): Promise<Version[]> } }).historyApi!.versions("User", id, { limit: 1 });
      expect(latest.map((version) => [version.version, version.operation])).toEqual([[2, "update"]]);
    } finally {
      await service.stop();
    }
  });
});

describe("override files and the store", () => {
  test("a project endpoint replaces one entity's history list route and a project job replaces the prune job, each with an override line", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": config("{}"),
      ...ENTITIES,
      "endpoints/users/[id]/history/get.ts": "export default () => ({ custom: true });\n",
      "jobs/history/prune.ts": 'import { job } from "@quickservicets/core";\nexport default job("@weekly", async () => ({ custom: true }));\n',
    });
    const summary = await build(root);
    const lines = [...(summary.overrides ?? []), ...(summary.buildSteps ?? []).flatMap((step) => step.lines)];
    expect(lines).toContain("Override: endpoints/users/[id]/history/get.ts replaces GET /users/[id]/history from history");
    expect(lines.some((line) => line.startsWith("Override: jobs/history/prune.ts replaces"))).toBe(true);
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config("{}"),
        ...ENTITIES,
        "endpoints/users/[id]/history/get.ts": "export default () => ({ custom: true });\n",
      },
    });
    try {
      const id = await create(service);
      expect(await (await service.fetch(`/users/${id}/history`)).json()).toEqual({ custom: true });
      expect((await service.fetch(`/users/${id}/history/1`)).status).toBe(200);
      const session = ((await (await service.fetch("/sessions", send("POST", { token: "t" }))).json()) as { id: string }).id;
      expect(((await (await service.fetch(`/sessions/${session}/history`)).json()) as { total: number }).total).toBe(1);
    } finally {
      await service.stop();
    }
  });

  test("a memory store receives every version, serves both routes and prunes; the build adds no history tables", async () => {
    const store = `const versions: any[] = ((globalThis as any).storedVersions = []);
const pruned: unknown[] = ((globalThis as any).prunedCalls = []);
export const memoryStore = {
  write(version: any, ctx: { entity: string }) {
    const stored = { ...version, entity: ctx.entity, version: versions.filter((v) => v.entity === ctx.entity && v.entityId === version.entityId).length + 1 };
    versions.push(stored);
    return stored;
  },
  async list(entity: string, id: string, query: { limit: number; offset: number }) {
    const found = versions.filter((v) => v.entity === entity && v.entityId === id).sort((a, b) => b.version - a.version);
    return { data: found.slice(query.offset, query.offset + query.limit), total: found.length };
  },
  async get(entity: string, id: string, version: number) {
    return versions.find((v) => v.entity === entity && v.entityId === id && v.version === version) ?? null;
  },
  async prune(entity: string, before: Date, keepLatest: boolean) {
    pruned.push({ entity, keepLatest, before: before instanceof Date });
    return 0;
  },
};
`;
    const files = {
      "quickservicets.config.ts": config('{ store: memoryStore, retention: "30d" }').replace('import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";', 'import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";\nimport { memoryStore } from "./store.ts";'),
      "store.ts": store,
      ...ENTITIES,
    };
    const service = await startTestService({ files });
    try {
      const id = await create(service);
      await service.fetch(`/users/${id}`, send("PATCH", { name: "B" }));
      expect((globalThis as { storedVersions?: Version[] }).storedVersions!.filter((version) => version.entityId === id)).toHaveLength(2);
      const list = (await (await service.fetch(`/users/${id}/history`)).json()) as { total: number; data: Version[] };
      expect([list.total, list.data[0]!.version]).toEqual([2, 2]);
      expect(((await (await service.fetch(`/users/${id}/history/1`)).json()) as Version).operation).toBe("create");
      expect((service.repos as Record<string, unknown>).userHistory).toBeUndefined();
    } finally {
      await service.stop();
    }
    const root = createLinkedProject({ ...files, "quickservicets.config.ts": files["quickservicets.config.ts"].replace("memoryAdapter()", 'sqliteAdapter({ path: ":memory:" })') });
    const migration = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(migration).not.toContain("user_history");
    await build(root);
    const pruned = await run(["history", "prune"], { log: () => undefined, error: () => undefined }, root);
    expect(pruned).toBe(0);
    expect((globalThis as { prunedCalls?: unknown[] }).prunedCalls).toEqual([
      { entity: "Session", keepLatest: true, before: true },
      { entity: "User", keepLatest: true, before: true },
    ]);
  });
});

describe("the reference page", () => {
  test("lists the options with their variables, the tag, the hooks, the command and the feature API", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/history.mdx"), "utf8");
    for (const text of ["`QS_HISTORY_RETENTION`", "`QS_HISTORY_ENTITIES`", "`history.beforeVersion`", "`history.afterVersion`", "`history.store`", "### `@history`", "quickservicets history prune", "## Feature API", "### `versions`"]) {
      expect(page).toContain(text);
    }
  });
});
