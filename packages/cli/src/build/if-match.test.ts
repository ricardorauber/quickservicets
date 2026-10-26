import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (etag = "{}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), etag: ${etag} });
`;
const files = (etag = "{}") => ({
  "quickservicets.config.ts": config(etag),
  "entities/Organization.ts": "export type Organization = { name: string };\n",
  "entities/User.ts": 'import type { Organization } from "./Organization.ts";\nexport type User = {\n  name: string;\n  /** @onDelete cascade */\n  organization?: Organization;\n};\n',
  "entities/Invoice.ts": "/** @etag required=true */\nexport type Invoice = { total: number };\n",
});
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService, path: string, body: unknown) => {
  const response = await service.fetch(path, send("POST", body));
  return { ...((await response.json()) as { id: string }), tag: response.headers.get("etag")! };
};
const errorOf = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string; message: string } }).error] as const;

describe("conditional writes", () => {
  test("a PATCH with the read's tag succeeds with a new tag; repeating it with the old tag is 412 with the current tag", async () => {
    const service = await startTestService({ files: files() });
    try {
      const user = await create(service, "/users", { name: "Ada" });
      const readTag = (await service.fetch(`/users/${user.id}`)).headers.get("etag")!;
      const patched = await service.fetch(`/users/${user.id}`, send("PATCH", { name: "Ada L." }, { "if-match": readTag }));
      expect(patched.status).toBe(200);
      const newTag = patched.headers.get("etag")!;
      expect(newTag).not.toBe(readTag);
      const stale = await service.fetch(`/users/${user.id}`, send("PATCH", { name: "Lost" }, { "if-match": readTag }));
      expect(stale.headers.get("etag")).toBe(newTag);
      expect(await errorOf(stale)).toEqual([412, { code: "PRECONDITION_FAILED", message: "Record was changed by another request" }]);
      expect(((await (await service.fetch(`/users/${user.id}`)).json()) as { name: string }).name).toBe("Ada L.");
    } finally {
      await service.stop();
    }
  });

  test("two concurrent PUTs with one tag give one 200 and one 412", async () => {
    const service = await startTestService({ files: files() });
    try {
      const user = await create(service, "/users", { name: "Ada" });
      const results = await Promise.all(["one", "two"].map((name) => service.fetch(`/users/${user.id}`, send("PUT", { name }, { "if-match": user.tag }))));
      expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    } finally {
      await service.stop();
    }
  });

  test("If-Match: * updates an existing record and is 404 for a missing one; a weak tag is 412", async () => {
    const service = await startTestService({ files: files() });
    try {
      const user = await create(service, "/users", { name: "Ada" });
      expect((await service.fetch(`/users/${user.id}`, send("PATCH", { name: "B" }, { "if-match": "*" }))).status).toBe(200);
      expect((await service.fetch("/users/01a00000-0000-7000-8000-000000000000", send("PATCH", { name: "B" }, { "if-match": "*" }))).status).toBe(404);
      const tag = (await service.fetch(`/users/${user.id}`)).headers.get("etag")!;
      expect((await service.fetch(`/users/${user.id}`, send("PATCH", { name: "C" }, { "if-match": `W/${tag}` }))).status).toBe(412);
    } finally {
      await service.stop();
    }
  });

  test("a matching DELETE cascades as before", async () => {
    const service = await startTestService({ files: files() });
    try {
      const org = await create(service, "/organizations", { name: "Acme" });
      await create(service, "/users", { name: "a", organization: org.id });
      expect((await service.fetch(`/organizations/${org.id}`, send("DELETE", undefined, { "if-match": org.tag }))).status).toBe(204);
      expect(((await (await service.fetch("/users")).json()) as { data: unknown[] }).data).toEqual([]);
    } finally {
      await service.stop();
    }
  });
});

describe("repositories", () => {
  test("repos.users.update with an old tag throws a 412 HttpError in a job", async () => {
    const service = await startTestService({
      files: {
        ...files(),
        "jobs/stale.ts": `import { HttpError, job } from "@quickservicets/core";
export default job({ every: "1h" }, async (ctx) => {
  const [user] = await (ctx.repos as unknown as { users: { query(): { toArray(): Promise<{ id: string }[]> } } }).users.query().toArray();
  try {
    await (ctx.repos as unknown as { users: { update(id: string, changes: object, options: object): Promise<unknown> } }).users.update(user!.id, { name: "x" }, { ifMatch: '"old"' });
    return { status: 200 };
  } catch (error) {
    return { status: (error as HttpError).status, isHttpError: error instanceof HttpError };
  }
});
`,
        "endpoints/run/post.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default async (_repos: unknown, req: ServiceRequest) => req.jobs.run("stale");\n',
      },
    });
    try {
      await create(service, "/users", { name: "Ada" });
      const { runId } = (await (await service.fetch("/run", send("POST", {}))).json()) as { runId: string };
      const runs = (service.repos as unknown as { jobRuns: { findById(id: string): Promise<{ status: string; result?: unknown } | null> } }).jobRuns;
      for (let attempt = 0; attempt < 200 && (await runs.findById(runId))?.status === "running"; attempt++) await Bun.sleep(10);
      expect((await runs.findById(runId))?.result).toEqual({ status: 412, isHttpError: true });
    } finally {
      await service.stop();
    }
  });
});

describe("required tags", () => {
  test("@etag required=true makes Invoice writes without If-Match 428, while User writes need none; etag.required applies to every entity", async () => {
    const service = await startTestService({ files: files() });
    try {
      const invoice = await create(service, "/invoices", { total: 10 });
      expect(await errorOf(await service.fetch(`/invoices/${invoice.id}`, send("DELETE")))).toEqual([428, { code: "PRECONDITION_REQUIRED", message: "If-Match header is required" }]);
      expect((await service.fetch(`/invoices/${invoice.id}`, send("DELETE", undefined, { "if-match": invoice.tag }))).status).toBe(204);
      const user = await create(service, "/users", { name: "Ada" });
      expect((await service.fetch(`/users/${user.id}`, send("PATCH", { name: "B" }))).status).toBe(200);
    } finally {
      await service.stop();
    }
    const strict = await startTestService({ files: files("{ required: true }") });
    try {
      const user = await create(strict, "/users", { name: "Ada" });
      expect((await strict.fetch(`/users/${user.id}`, send("PATCH", { name: "B" }))).status).toBe(428);
    } finally {
      await strict.stop();
    }
  });
});

describe("OpenAPI", () => {
  test("write routes document If-Match and 412, and 428 where required", async () => {
    const service = await startTestService({ files: files() });
    try {
      const doc = JSON.parse(readFileSync(join(service.root, ".generated/openapi.json"), "utf8"));
      const patch = doc.paths["/users/{id}"].patch;
      expect(patch.parameters).toContainEqual(expect.objectContaining({ name: "If-Match", in: "header", required: false }));
      expect(patch.responses["412"]).toBeDefined();
      expect(patch.responses["428"]).toBeUndefined();
      const deleteInvoice = doc.paths["/invoices/{id}"].delete;
      expect(deleteInvoice.parameters).toContainEqual(expect.objectContaining({ name: "If-Match", required: true }));
      expect(deleteInvoice.responses["428"]).toBeDefined();
    } finally {
      await service.stop();
    }
  });
});
