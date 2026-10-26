import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createRepositories, memoryAdapter, type Repositories } from "@quickservicets/core";
import { seed } from "../scripts/seed.ts";

const root = join(import.meta.dir, "..");

beforeAll(() => {
  const built = Bun.spawnSync(["bun", "run", "quickservicets", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}${built.stdout.toString()}`);
});

test("seeding twice creates the sample dataset once", async () => {
  const { models } = await import(join(root, ".generated/models.ts"));
  const database = memoryAdapter();
  await database.connect(models);
  const repos = createRepositories(models, database) as unknown as Repositories;
  const kinds = ["modules", "permissions", "profiles", "organizations", "users", "memberships", "teams"] as const;
  const counts = async () => Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await repos[kind].query().count()])));
  const expected = { modules: 3, permissions: 6, profiles: 3, organizations: 2, users: 3, memberships: 4, teams: 1 };

  const first = await seed(repos);
  expect(Object.values(first).every(({ existing }) => existing === 0)).toBe(true);
  expect(await counts()).toEqual(expected);

  const second = await seed(repos);
  expect(Object.fromEntries(Object.entries(second).map(([kind, { created, existing }]) => [kind, [created, existing]]))).toEqual(
    Object.fromEntries(Object.entries(expected).map(([kind, count]) => [kind, [0, count]])),
  );
  expect(await counts()).toEqual(expected);

  const ana = await repos.users.where((u) => u.email.eq("ana@acme.co")).include("memberships", "teams").first();
  expect([ana.role, ana.memberships.length, ana.teams.map((team) => team.name)]).toEqual(["admin", 2, ["Data"]]);
  await database.disconnect();
});
