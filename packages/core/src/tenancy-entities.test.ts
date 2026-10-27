import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import { job } from "./jobs/job.ts";
import { configureRepositories, repositoriesFor, type Repository } from "./repository.ts";
import { tenantRepositories, TenantRequiredError } from "./tenant-repositories.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const plan = entity("Plan", [field({ name: "name", type: "string" })], { tags: { tenancy: { on: true, options: { scope: "shared" } } } });
const models = markTenancy([entity("Post", [field({ name: "title", type: "string" })]), plan]);
const [post] = models;

const running: TestApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

describe("tenant registries", () => {
  test("tenant models use the tenant adapter's repositories and shared models the root's", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    configureRepositories(models);
    const view = adapter.withSchema!("tenant-a");
    const root = repositoriesFor(adapter);
    const registry = tenantRepositories(root, view);
    expect(tenantRepositories(root, view)).toBe(registry);
    expect(registry.plans).toBe(root.plans);
    expect(registry.posts).toBe(repositoriesFor(view).posts);
    const created = await (registry.posts as Repository).create({ title: "in a" });
    expect(await view.findById(post!, created.id)).not.toBeNull();
    expect(await adapter.findById(post!, created.id)).toBeNull();
  });
});

describe("tenant data without a tenant", () => {
  test("an exempt endpoint answers 400 for tenant data and reads shared data; a job throws the TenantRequiredError message", async () => {
    let failure: unknown;
    const app = await startTestApp({
      config: { tenancy: { source: "config", tenants: { acme: {} } } },
      models,
      endpoints: [
        { path: "/public/posts", handler: (repos) => (repos as Record<string, Repository>).posts!.list({ where: [], sort: [], limit: 10, offset: 0 }), tags: { tenancy: { on: false, options: {} } } },
        { path: "/public/plans", handler: (repos) => (repos as Record<string, Repository>).plans!.list({ where: [], sort: [], limit: 10, offset: 0 }), tags: { tenancy: { on: false, options: {} } } },
      ],
      jobs: new Map([
        [
          "report",
          job({ every: "1h" }, async (ctx) => {
            const repos = ctx.repos as unknown as Record<string, Repository>;
            await repos.plans!.list({ where: [], sort: [], limit: 10, offset: 0 });
            try {
              await repos.posts!.list({ where: [], sort: [], limit: 10, offset: 0 });
            } catch (error) {
              failure = error;
              throw error;
            }
          }),
        ],
      ]),
    });
    running.push(app);
    expect(await errorOf(await app.fetch("/public/posts"))).toEqual({ status: 400, code: "TENANT_REQUIRED", message: "Tenant is required" });
    expect((await app.fetch("/public/plans")).status).toBe(200);
    const run = await app.app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(run?.status).toBe("failed");
    expect(failure).toBeInstanceOf(TenantRequiredError);
    expect((failure as Error).message).toBe("Post holds tenant data; run this for a tenant or tag the entity @tenancy shared");
  });
});
