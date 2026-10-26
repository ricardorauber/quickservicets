import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityModel } from "@quickservice/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (keys = "events: {}, history: {}", adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter, mongodbAdapter } from "@quickservice/core";
export default defineConfig({ database: ${adapter}${keys ? `, ${keys}` : ""} });
`;

/** A project feature that signs requests in as the user of the x-user header. */
const SIGN_IN = `import { defineFeature } from "@quickservice/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const id = req.headers.get("x-user"); if (id) (req as { user?: unknown }).user = { id }; return next(); } }],
});
`;

const FILES = {
  "quickservice.config.ts": config("events: {}, history: {}, signin: {}"),
  "features/signin/index.ts": SIGN_IN,
  "entities/User.ts": `/** @history */
export type User = {
  name: string;
  /** @hidden */
  passwordHash?: string;
  /** @history off */
  draft?: string;
  /**
   * @hidden
   * @history on
   */
  recoveryCode?: string;
};
`,
  "entities/Organization.ts": "/** @history */\nexport type Organization = { name: string };\n",
  "entities/Membership.ts": `import type { Organization } from "./Organization";
/** @history */
export type Membership = {
  role: string;
  /** @onDelete cascade */
  organization: Organization;
};
`,
  "entities/Note.ts": "export type Note = { text: string };\n",
};

const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Version = { entityId: string; version: number; operation: string; actor: string; requestId?: string; record: Record<string, unknown>; changed: string[] };
const versionsOf = async (service: TestService, repo: string, entityId?: string) => {
  const all = (await (service.repos as unknown as Record<string, { query(): { all(): Promise<Version[]> } }>)[repo]!.query().all()) as Version[];
  return all.filter((version) => entityId === undefined || version.entityId === entityId).sort((a, b) => a.version - b.version);
};
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("the model", () => {
  test("a tagged entity gets a read-only UserHistory system entity without routes or API docs", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((model) => model.key === "UserHistory")).toMatchObject({ system: true, tableName: "user_history", repoKey: "userHistory", feature: "history" });
      expect(models.some((model) => model.key === "NoteHistory")).toBe(false);
      expect((await service.fetch("/user-history")).status).toBe(404);
      const openApi = readFileSync(join(service.root, ".generated/openapi.json"), "utf8");
      expect(openApi).not.toContain("UserHistory");
    } finally {
      await service.stop();
    }
  });

  const adapters = { sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' };
  for (const [name, adapter] of Object.entries(adapters)) {
    test(`${name}: migration add creates user_history with its indexes`, async () => {
      const root = createLinkedProject({ ...FILES, "quickservice.config.ts": config("events: {}, history: {}", adapter) });
      const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?user_history/);
      expect(created).toMatch(/CREATE UNIQUE INDEX[^\n]*user_history[^\n]*entity_id[^\n]*version/i);
      expect(created).toMatch(/CREATE INDEX[^\n]*user_history[^\n]*entity_id[^\n]*\bat\b/i);
    });
  }

  test("mongodb: migration add creates the history indexes", async () => {
    const root = createLinkedProject({ ...FILES, "quickservice.config.ts": config("events: {}, history: {}", 'mongodbAdapter({ url: "mongodb://localhost/none", database: "x" })') });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toContain('collection("user_history").createIndex({"entityId":1,"version":1}');
    expect(created).toContain('collection("user_history").createIndex({"entityId":1,"at":1}');
  });

  test("history without events fails with the requirement; all covers every regular entity but those tagged @history off, never JobRun", async () => {
    const without = createLinkedProject({ ...FILES, "quickservice.config.ts": config("history: {}, signin: {}") });
    expect((await failure(() => build(without))).message).toContain("history requires events; add events: {} to quickservice.config.ts");
    const all = createLinkedProject({
      ...FILES,
      "quickservice.config.ts": config('events: {}, history: { entities: "all" }'),
      "entities/Session.ts": "/** @history off */\nexport type Session = { token: string };\n",
      "jobs/cleanup.ts": 'import { job } from "@quickservice/core";\nexport default job({ every: "1h" }, async () => undefined);\n',
    });
    await build(all);
    const models = (await import(join(all, ".generated/models.ts"))).models as EntityModel[];
    const keys = models.filter((model) => model.feature === "history").map((model) => model.key);
    expect(keys.sort()).toEqual(["MembershipHistory", "NoteHistory", "OrganizationHistory", "UserHistory"]);
    expect(models.some((model) => model.key === "JobRun")).toBe(true);
  });

  test("a field tag @history with an option fails the build", async () => {
    const root = createLinkedProject({ ...FILES, "entities/Note.ts": "export type Note = {\n  /** @history keep=1 */\n  text: string;\n};\n" });
    expect((await failure(() => build(root))).message).toContain("entities/Note.ts: invalid @history: takes no options, got keep");
  });
});

describe("versions over HTTP", () => {
  test("create, two updates and a delete store versions 1 to 4, with the request's user and id", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const created = await service.fetch("/users", send("POST", { name: "A", passwordHash: "h", draft: "d", recoveryCode: "r" }, { "x-user": "u1" }));
      const requestId = created.headers.get("x-request-id");
      const { id } = (await created.json()) as { id: string };
      await service.fetch(`/users/${id}`, send("PATCH", { name: "B" }));
      await service.fetch(`/users/${id}`, send("PATCH", { name: "C", draft: "e" }));
      await service.fetch(`/users/${id}`, { method: "DELETE" });
      const versions = await versionsOf(service, "userHistory", id);
      expect(versions.map((version) => [version.version, version.operation])).toEqual([
        [1, "create"],
        [2, "update"],
        [3, "update"],
        [4, "delete"],
      ]);
      expect(versions[0]!.actor).toBe("user:u1");
      if (requestId) expect(versions[0]!.requestId).toBe(requestId);
      expect(versions[0]!.requestId).toBeString();
      expect(versions[1]!.actor).toBe("system");
      expect(versions[2]!.changed.sort()).toEqual(["draft", "name"]);
      expect(versions[3]!.record).toMatchObject({ id, name: "C" });
      for (const version of versions) {
        expect(Object.keys(version.record)).not.toContain("passwordHash");
        expect(Object.keys(version.record)).not.toContain("draft");
        expect(version.record.recoveryCode).toBe("r");
      }
    } finally {
      await service.stop();
    }
  });

  test("deleting an organization stores a delete version for each cascaded membership", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const org = (await (await service.fetch("/organizations", send("POST", { name: "Acme" }))).json()) as { id: string };
      const ids: string[] = [];
      for (const role of ["admin", "member"]) ids.push(((await (await service.fetch("/memberships", send("POST", { role, organization: org.id }))).json()) as { id: string }).id);
      expect((await service.fetch(`/organizations/${org.id}`, { method: "DELETE" })).status).toBe(204);
      for (const id of ids) expect((await versionsOf(service, "membershipHistory", id)).map((version) => version.operation)).toEqual(["create", "delete"]);
      expect((await versionsOf(service, "organizationHistory", org.id)).map((version) => version.operation)).toEqual(["create", "delete"]);
    } finally {
      await service.stop();
    }
  });
});
