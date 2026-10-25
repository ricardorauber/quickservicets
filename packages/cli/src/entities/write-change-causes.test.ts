import { afterEach, describe, expect, test } from "bun:test";
import {
  createRepositories,
  memoryAdapter,
  mongodbAdapter,
  events,
  observeWrites,
  postgresAdapter,
  sqliteAdapter,
  type DatabaseAdapter,
  type Repository,
  type WriteChange,
  type WriteEvent,
} from "@quickservice/core";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { resetPostgresTables } from "../../../core/src/testing/postgres.ts";
import { createProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { parseEntities } from "./parse-entities.ts";

type Factory = () => DatabaseAdapter;
const factories: [string, Factory][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `qs_cause_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

async function setup(factory: Factory, organization: string, user: string, wrap?: (adapter: DatabaseAdapter) => DatabaseAdapter) {
  const models = parseEntities(
    createProject({
      "entities/Organization.ts": `import type { User } from "./User";\nexport type Organization = { name: string; ${organization} }`,
      "entities/User.ts": `import type { Organization } from "./Organization";\nexport type User = { name: string; ${user} }`,
    }),
  );
  const base = factory();
  await base.connect(models);
  const client = (base as unknown as { client: never }).client;
  if (base.kind === "sqlite") await createSqliteTables(client, models);
  if (base.kind === "postgres") await resetPostgresTables(client, models);
  const adapter = wrap ? wrap(base) : base;
  const repos = createRepositories(models, adapter) as Record<string, Repository>;
  return { adapter: base, users: repos.users!, organizations: repos.organizations! };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
/** Records every change reported to an observer that needs `before`. */
const record = () => {
  const changes: WriteChange[] = [];
  stops.push(observeWrites({ needsBefore: true, write: (change) => void changes.push(change) }));
  return changes;
};
const summary = (changes: WriteChange[]) => changes.map((change) => `${change.entity.key}.${change.operation}:${change.cause}`);

describe.each(factories)("%s", (_, factory) => {
  test("a cascade delete reports each deleted child, then the parent", async () => {
    const { users, organizations, adapter } = await setup(factory, "", "/** @onDelete cascade */ organization?: Organization");
    const org = await organizations.create({ name: "o" });
    const [a, b] = [await users.create({ name: "a", organization: org.id }), await users.create({ name: "b", organization: org.id })];
    const changes = record();
    await organizations.delete(org.id);
    expect(summary(changes)).toEqual(["User.deleted:cascade", "User.deleted:cascade", "Organization.deleted:write"]);
    expect(changes.slice(0, 2).map((change) => change.id).sort()).toEqual([a.id, b.id].sort());
    expect(changes[0]!.before).toMatchObject({ organization: org.id });
    expect(changes[0]!.after).toBeNull();
    await adapter.disconnect();
  });

  test("set null and pull report the updated records with the field", async () => {
    const { users, organizations, adapter } = await setup(factory, "", "/** @onDelete setNull */ organization?: Organization; /** @onDelete pull */ partners?: Organization[]");
    const org = await organizations.create({ name: "o" });
    const other = await organizations.create({ name: "p" });
    await users.create({ name: "a", organization: org.id });
    await users.create({ name: "b", partners: [org.id, other.id] });
    const changes = record();
    await organizations.delete(org.id);
    const setNull = changes.find((change) => change.cause === "setNull")!;
    expect(setNull).toMatchObject({ operation: "updated", changed: ["organization"] });
    expect(setNull.before!.organization).toBe(org.id);
    expect(setNull.after!.organization).toBeNull();
    const pulled = changes.find((change) => change.cause === "pull")!;
    expect(pulled).toMatchObject({ operation: "updated", changed: ["partners"] });
    expect(pulled.after!.partners).toEqual([other.id]);
    expect(changes.at(-1)).toMatchObject({ cause: "write", operation: "deleted" });
    await adapter.disconnect();
  });

  test("relation sync reports the written record first, then each touched one", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organization?: Organization");
    const org = await organizations.create({ name: "o" });
    const user = await users.create({ name: "u" });
    const changes = record();
    await organizations.update(org.id, { users: [user.id] });
    expect(summary(changes)).toEqual(["Organization.updated:write", "User.updated:touch"]);
    expect(changes[1]).toMatchObject({ id: user.id, changed: ["organization"] });
    await adapter.disconnect();
  });

  test("moving a 1-1 link with @onConflict replace touches the previous holder", async () => {
    const { users, organizations, adapter } = await setup(factory, "/** @onConflict replace */ user?: User", "organization?: Organization");
    const [o1, o2] = [await organizations.create({ name: "o1" }), await organizations.create({ name: "o2" })];
    const user = await users.create({ name: "u" });
    await organizations.update(o1.id, { user: user.id });
    const changes = record();
    await organizations.update(o2.id, { user: user.id });
    expect(changes[0]).toMatchObject({ cause: "write", id: o2.id });
    expect(changes.some((change) => change.cause === "touch" && change.id === o1.id && change.changed.includes("user"))).toBe(true);
    await adapter.disconnect();
  });

  test("an N-N add from the user side touches the organization", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organizations?: Organization[]");
    const org = await organizations.create({ name: "o" });
    const user = await users.create({ name: "u" });
    const changes = record();
    await users.update(user.id, { organizations: { add: [org.id] } });
    expect(summary(changes)).toEqual(["User.updated:write", "Organization.updated:touch"]);
    expect(changes[1]).toMatchObject({ id: org.id, changed: ["users"] });
    await adapter.disconnect();
  });
});

describe("reads and statements", () => {
  test("with an observer, a cascade delete reuses the children it found instead of reading each again", async () => {
    const reads: string[] = [];
    const counting = (adapter: DatabaseAdapter): DatabaseAdapter => ({
      ...adapter,
      transaction: (fn) => adapter.transaction(fn),
      findById: (entity, id, options) => (reads.push(entity.key), adapter.findById(entity, id, options)),
    });
    const { users, organizations } = await setup(factories[0]![1], "", "/** @onDelete cascade */ organization?: Organization", counting);
    const org = await organizations.create({ name: "o" });
    await users.create({ name: "a", organization: org.id });
    await users.create({ name: "b", organization: org.id });
    record();
    reads.length = 0;
    await organizations.delete(org.id);
    expect(reads.filter((key) => key === "User")).toEqual([]);
  });

  test("without observers, deletes still pull ids in place", async () => {
    let inPlace = 0;
    const counting = (adapter: DatabaseAdapter): DatabaseAdapter => ({
      ...adapter,
      transaction: (fn) => adapter.transaction(fn),
      deleteAndPull: (...args) => (inPlace++, adapter.deleteAndPull!(...args)),
    });
    const { users, organizations } = await setup(factories[1]![1], "", "/** @onDelete pull */ partners?: Organization[]", counting);
    const org = await organizations.create({ name: "o" });
    await users.create({ name: "b", partners: [org.id] });
    await organizations.delete(org.id);
    expect(inPlace).toBe(1);
  });
});

describe("the events native", () => {
  test("a cascade delete over HTTP emits one event per record with the same request and actor", async () => {
    const service = await startTestService({
      files: {
        "quickservice.config.ts": 'import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter(), events: {} });\n',
        "entities/Organization.ts": "export type Organization = { name: string };\n",
        "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; /** @onDelete cascade */ organization: Organization };\n',
      },
    });
    try {
      const post = (path: string, body: unknown) => service.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const org = (await (await post("/organizations", { name: "o" })).json()) as { id: string };
      await post("/users", { name: "a", organization: org.id });
      await post("/users", { name: "b", organization: org.id });
      await events.idle();
      const seen: { type: string; cause: string; requestId?: string; actor: unknown }[] = [];
      events.on("*", (event) => void seen.push(event as WriteEvent));
      await service.fetch(`/organizations/${org.id}`, { method: "DELETE" });
      await events.idle();
      expect(seen.map((event) => `${event.type}:${event.cause}`)).toEqual(["user.deleted:cascade", "user.deleted:cascade", "organization.deleted:write"]);
      expect(new Set(seen.map((event) => event.requestId)).size).toBe(1);
      expect(seen[0]!.requestId).toBeString();
      expect(new Set(seen.map((event) => JSON.stringify(event.actor))).size).toBe(1);
    } finally {
      await service.stop();
    }
  });
});
