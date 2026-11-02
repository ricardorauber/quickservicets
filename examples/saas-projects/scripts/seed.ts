/**
 * Fills the database with the sample plans, workspaces, projects and tasks: `bun run seed`, after
 * `bun run migrate`. It starts the built service in this process (without listening for long and without jobs), so
 * workspaces are provisioned exactly as the sign-up endpoint provisions them.
 */
import { startService } from "@quickservicets/core";
import projectConfig from "../quickservicets.config.ts";
import { featureFolders, features } from "../.generated/features.ts";
import { jobs } from "../.generated/jobs.ts";
import { models } from "../.generated/models.ts";
import openApi from "../.generated/openapi.json";
import { crudRoutes, endpoints, hooks } from "../.generated/routes.ts";
import { seedShowcase } from "../lib/seed.ts";

const service = await startService({
  projectConfig,
  models,
  crudRoutes,
  endpoints,
  hooks,
  jobs,
  openApi,
  features,
  featureFolders,
  generatedDir: new URL("../.generated", import.meta.url).pathname,
  env: { ...process.env, QS_SERVER_PORT: process.env.SEED_PORT ?? "3999", QS_SERVER_WORKERS: "1", QS_JOBS_ENABLED: "false" },
  process: { once: () => {}, exit: (code: number) => process.exit(code) } as never,
});
if (!service) process.exit(1);
try {
  await seedShowcase(service.app.repos as never);
  console.log("Seeded the plans free, pro and enterprise and the workspaces acme, globex and initech");
} finally {
  await service.stop();
}
