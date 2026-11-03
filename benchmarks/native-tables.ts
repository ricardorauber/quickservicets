#!/usr/bin/env bun
/**
 * Prints the SQL that creates the tables of the natives a benchmark run switches on (like `queue_messages` for
 * `queues`), for the runner to apply after it resets the schema. It builds the benchmark service on the host with the
 * run's `QS_*` variables, which the runner passes in the environment, and keeps the models a feature owns.
 *
 *   QS_WEBHOOKS_ENABLED=true bun benchmarks/native-tables.ts
 */
import { join } from "node:path";
import type { EntityModel } from "../packages/core/src/index.ts";
import { postgresDdl } from "../packages/core/src/testing/postgres.ts";

const project = join(import.meta.dir, "quickservicets");
const build = Bun.spawn(["bun", "run", "build"], { cwd: project, stdout: "pipe", stderr: "pipe", env: process.env });
const [output, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
if (code !== 0) {
  console.error(output);
  process.exit(1);
}
const { models } = (await import(join(project, ".generated", "models.ts"))) as { models: EntityModel[] };
const owned = models.filter((model) => (model as { feature?: string }).feature !== undefined);
const statements = owned.length === 0 ? [] : await postgresDdl(owned);
console.log(statements.map((statement) => `${statement.trim().replace(/;$/, "")};`).join("\n"));
