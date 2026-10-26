import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
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

const ROUTE_FILES = {
  ...FILES,
  "entities/User.ts": FILES["entities/User.ts"].replace("/** @history */", "/**\n * @history\n * @own:read\n */"),
  "hooks/own.ts": `import { definePreHook, HttpError } from "@quickservice/core";
export default definePreHook((_repos, req) => {
  const user = req.headers.get("x-user");
  if (user && user !== req.params.id) throw new HttpError(403, "Forbidden");
});
`,
  "entities/AuditEntry.ts": "/**\n * @internal\n * @history\n */\nexport type AuditEntry = { line: string };\n",
  "endpoints/audit/post.ts": `import type { Repositories } from "@quickservice/core";
export default async (repos: Repositories) => (repos as unknown as { auditEntries: { create(data: object): Promise<unknown> } }).auditEntries.create({ line: "x" });
`,
};

type Page = { data: (Version & { at: string; entityId?: string })[]; total: number; limit: number; offset: number };
const get = async (service: TestService, path: string, headers: Record<string, string> = {}) => {
  const response = await service.fetch(path, { headers });
  return { status: response.status, body: (await response.json()) as Page & { error?: { code: string; message: string; details?: { field: string }[] } } };
};

describe("history routes", () => {
  test("the list is newest first and paginated, filters by operation, time and actor, and rejects other parameters", async () => {
    const service = await startTestService({ files: ROUTE_FILES });
    try {
      const { id } = (await (await service.fetch("/users", send("POST", { name: "A" }))).json()) as { id: string };
      await Bun.sleep(5);
      await service.fetch(`/users/${id}`, send("PATCH", { name: "B" }));
      const list = await get(service, `/users/${id}/history`);
      expect(list.status).toBe(200);
      expect([list.body.total, list.body.limit, list.body.offset, list.body.data.map((version) => version.version)]).toEqual([2, 20, 0, [2, 1]]);
      expect(Object.keys(list.body.data[0]!).sort()).toEqual(["actor", "at", "changed", "operation", "record", "requestId", "version"]);
      expect((await get(service, `/users/${id}/history?limit=1&offset=1`)).body.data.map((version) => version.version)).toEqual([1]);
      expect((await get(service, `/users/${id}/history?where[operation][eq]=update`)).body.data.map((version) => version.operation)).toEqual(["update"]);
      expect((await get(service, `/users/${id}/history?where[operation][in]=create,delete`)).body.total).toBe(1);
      expect((await get(service, `/users/${id}/history?where[actor][eq]=system`)).body.total).toBe(2);
      const second = list.body.data[0]!.at;
      expect((await get(service, `/users/${id}/history?where[at][gte]=${encodeURIComponent(second)}`)).body.data.map((version) => version.version)).toEqual([2]);
      expect((await get(service, `/users/${id}/history?where[at][lt]=2000-01-01`)).body.total).toBe(0);
      for (const parameter of ["where[version][eq]=1", "sort=at", "where[operation][ne]=create"]) {
        const refused = await get(service, `/users/${id}/history?${parameter}`);
        expect(refused.status).toBe(400);
        expect(refused.body.error!.details!.map((detail) => detail.field)).toEqual([parameter.split("=")[0]!]);
      }
      expect((await get(service, `/users/${id}/history?limit=0`)).status).toBe(400);
    } finally {
      await service.stop();
    }
  });

  test("one version, its validation and not-found messages, and versions of deleted or unknown records", async () => {
    const service = await startTestService({ files: ROUTE_FILES });
    try {
      const { id } = (await (await service.fetch("/users", send("POST", { name: "A" }))).json()) as { id: string };
      const first = await service.fetch(`/users/${id}/history/1`);
      expect(first.status).toBe(200);
      expect(((await first.json()) as Version).operation).toBe("create");
      const missing = await get(service, `/users/${id}/history/9`);
      expect([missing.status, missing.body.error!.code, missing.body.error!.message]).toEqual([404, "NOT_FOUND", "User version 9 not found"]);
      for (const bad of ["abc", "0", "-1", "1.5"]) {
        const invalid = await get(service, `/users/${id}/history/${bad}`);
        expect([invalid.status, invalid.body.error!.code, invalid.body.error!.details![0]!.field]).toEqual([400, "VALIDATION_ERROR", "version"]);
      }
      const unknown = await get(service, "/users/0190f0e0-0000-7000-8000-000000000000/history");
      expect([unknown.status, unknown.body.error!.message]).toEqual([404, "User not found"]);
      expect((await get(service, `/users/${id}/history?where[operation][eq]=delete`)).status).toBe(200);
      await service.fetch(`/users/${id}`, { method: "DELETE" });
      expect((await get(service, `/users/${id}/history`)).body.total).toBe(2);
      expect((await service.fetch(`/users/${id}/history/2`)).status).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test("the read hooks of the entity guard both routes", async () => {
    const service = await startTestService({ files: ROUTE_FILES });
    try {
      const { id } = (await (await service.fetch("/users", send("POST", { name: "A" }))).json()) as { id: string };
      expect((await service.fetch(`/users/${id}`, { headers: { "x-user": "other" } })).status).toBe(403);
      expect((await service.fetch(`/users/${id}/history`, { headers: { "x-user": "other" } })).status).toBe(403);
      expect((await service.fetch(`/users/${id}/history/1`, { headers: { "x-user": "other" } })).status).toBe(403);
      expect((await service.fetch(`/users/${id}/history`, { headers: { "x-user": id } })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test("a hidden field kept by @history on is stored but never answered", async () => {
    const service = await startTestService({ files: ROUTE_FILES });
    try {
      const { id } = (await (await service.fetch("/users", send("POST", { name: "A", recoveryCode: "r" }))).json()) as { id: string };
      expect((await versionsOf(service, "userHistory", id))[0]!.record.recoveryCode).toBe("r");
      expect(Object.keys((await get(service, `/users/${id}/history`)).body.data[0]!.record)).not.toContain("recoveryCode");
      expect(Object.keys(((await (await service.fetch(`/users/${id}/history/1`)).json()) as Version).record)).not.toContain("recoveryCode");
    } finally {
      await service.stop();
    }
  });

  test("OpenAPI documents both routes with UserVersion; internal entities get no routes but keep their versions", async () => {
    const service = await startTestService({ files: ROUTE_FILES });
    try {
      const document = JSON.parse(readFileSync(join(service.root, ".generated/openapi.json"), "utf8"));
      expect((await validate(structuredClone(document))).errors).toEqual([]);
      const list = document.paths["/users/{id}/history"].get;
      expect(list.tags).toEqual(document.paths["/users/{id}"].get.tags);
      expect(list.parameters.map((parameter: { name: string }) => parameter.name)).toContain("where[at][gte]");
      expect(Object.keys(list.responses)).toEqual(["200", "400", "404"]);
      expect(Object.keys(document.paths["/users/{id}/history/{version}"].get.responses)).toEqual(["200", "400", "404"]);
      expect(document.components.schemas.UserVersion.properties.record).toEqual(document.paths["/users/{id}"].get.responses["200"].content["application/json"].schema);
      expect(Object.keys(document.paths).some((path) => path.includes("audit-entries"))).toBe(false);
      const created = await service.fetch("/audit", send("POST", {}));
      const { id } = (await created.json()) as { id: string };
      expect((await service.fetch(`/audit-entries/${id}/history`)).status).toBe(404);
      expect((await versionsOf(service, "auditEntryHistory", id)).map((version) => version.operation)).toEqual(["create"]);
    } finally {
      await service.stop();
    }
  });
});
