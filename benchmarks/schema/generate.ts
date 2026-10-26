/**
 * Regenerates benchmarks/schema/schema.sql from the QuickService.ts migrations (`quickservicets migration script`),
 * without the migration-history rows, which only QuickService.ts uses.
 *
 *   bun benchmarks/schema/generate.ts
 */
import { join } from "node:path";

const project = join(import.meta.dir, "..", "quickservicets");
const proc = Bun.spawn(["bun", "run", "--silent", "quickservicets", "migration", "script"], { cwd: project, stdout: "pipe", stderr: "inherit" });
const script = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) process.exit(1);

const body = script
  .split("\n")
  .filter((line) => !line.includes("__quickservicets_migrations") && !/^-- \d{14}_/.test(line))
  .join("\n")
  .trim();

const header = [
  "-- Generated from benchmarks/quickservicets/migrations with `quickservicets migration script`.",
  "-- Every stack uses exactly these tables. Regenerate with: bun benchmarks/schema/generate.ts",
];
await Bun.write(join(import.meta.dir, "schema.sql"), `${header.join("\n")}\n${body}\n`);
console.log("Wrote benchmarks/schema/schema.sql");
