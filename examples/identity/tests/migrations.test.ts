/**
 * The migrations of this project, applied one after the other on PostgreSQL.
 * Runs only when TEST_POSTGRES_URL is set, and replaces the `public` schema of that database.
 */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const url = process.env.TEST_POSTGRES_URL;

function quickservicets(...args: string[]): string {
  const result = Bun.spawnSync(["bun", "run", "quickservicets", ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`quickservicets ${args.join(" ")} failed:\n${output}`);
  return output;
}

if (url) {
  test("each migration applies on a database migrated up to the previous one", async () => {
    const admin = new SQL(url);
    try {
      await admin.unsafe("drop schema if exists public cascade; create schema public;");
      expect(quickservicets("migrate", "Initial")).toContain("Applied 20261016211954_Initial");
      const indexes = ["modules_slug_uq", "organizations_slug_uq", "profiles_slug_uq", "users_email_uq"];
      const uniqueIndexes = async () =>
        ((await admin`select indexname from pg_indexes where schemaname = 'public' and indexname in ${admin(indexes)} order by indexname`) as { indexname: string }[]).map(
          (row) => row.indexname,
        );
      expect(await uniqueIndexes()).toEqual([]);
      await admin.unsafe(
        "insert into modules (id, created_at, updated_at, slug, active) values ('01a10000-0000-7000-8000-000000000001', now(), now(), 'billing', true)",
      );
      expect(quickservicets("migrate", "JobRuns")).toContain("Applied 20261020133355_DataRules");
      expect(await uniqueIndexes()).toEqual(indexes);
      // PhaseOneFeatures adds the plan column, with existing organizations on the free plan, and the tables of the
      // history and idempotency natives.
      await admin.unsafe(
        "insert into organizations (id, created_at, updated_at, slug, legal_name, active) values ('01a10000-0000-7000-8000-000000000002', now(), now(), 'acme', 'Acme Ltd', true)",
      );
      expect(quickservicets("migrate")).toContain("Applied 20261027143638_PhaseOneFeatures");
      expect(((await admin`select plan from organizations`) as { plan: string }[]).map((row) => row.plan)).toEqual(["free"]);
      const tables = ((await admin`select tablename from pg_tables where schemaname = 'public' and tablename in ${admin(["idempotency_keys", "membership_history", "profile_history", "team_history"])} order by tablename`) as { tablename: string }[]).map((row) => row.tablename);
      expect(tables).toEqual(["idempotency_keys", "membership_history", "profile_history", "team_history"]);
      expect(quickservicets("migrate")).toContain("Database is up to date (0 migrations applied)");
    } finally {
      await admin.close();
    }
  }, 60_000);
} else {
  test.skip("migrations on PostgreSQL (set TEST_POSTGRES_URL to run)", () => {});
}
