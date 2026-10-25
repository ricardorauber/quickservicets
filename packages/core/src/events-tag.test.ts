import { afterEach, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { prepareFeatureTargets } from "./feature-targets.ts";
import { createFeatureLifecycle, type FeatureLifecycle } from "./lifecycle.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { recordStatements, resetPostgresTables } from "./testing/postgres.ts";

const session = entity("Session", [field({ name: "token", type: "string" })], { tags: { events: { on: false, options: {} } } });
const user = entity("User", [field({ name: "name", type: "string" })]);
const models = [session, user];

let lifecycle: FeatureLifecycle | undefined;
afterEach(async () => {
  await lifecycle?.shutdown();
  await lifecycle?.stop();
  lifecycle = undefined;
});

test("@events off leaves an entity unobserved, so its writes keep one statement on PostgreSQL", async () => {
  if (!process.env.TEST_POSTGRES_URL) return;
  const config = resolveConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, events: {} } as ServiceConfig, {});
  prepareFeatureTargets(models, []);
  lifecycle = createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await lifecycle.start({} as never);
  const adapter = postgresAdapter({ url: process.env.TEST_POSTGRES_URL });
  await adapter.connect(models);
  await resetPostgresTables(adapter.client!, models);
  const repos = createRepositories(models, adapter) as Record<string, Repository>;
  const statements = recordStatements(adapter.client!);
  await repos.sessions!.create({ token: "t" });
  expect(statements.statements).toHaveLength(1);
  statements.clear();
  await repos.users!.create({ name: "a" });
  expect(statements.statements[0]).toBe("begin");
  await adapter.disconnect();
});
