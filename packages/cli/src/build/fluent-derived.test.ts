import { expect, test } from "bun:test";
import { createRepositories, memoryAdapter, type Repository } from "@quickservice/core";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

test("fluent queries return and filter by derived relation sides", async () => {
  const models = parseProjectEntities(
    createProject({
      "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; users?: User[] }',
      "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; organization?: Organization }',
    }),
  );
  const adapter = memoryAdapter();
  await adapter.connect(models);
  const repos = createRepositories(models, adapter) as unknown as Record<string, Repository<any>>;
  const acme = await repos.organizations!.create({ name: "acme" });
  await repos.organizations!.create({ name: "empty" });
  const ana = await repos.users!.create({ name: "ana", organization: acme.id });
  const found = await repos.organizations!.where((o: any) => o.users.contains(ana.id)).all();
  expect(found.map((organization: any) => [organization.name, organization.users])).toEqual([["acme", [ana.id]]]);
});

test("aggregates filter by derived relation sides", async () => {
  const models = parseProjectEntities(
    createProject({
      "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; size: number; users?: User[] }',
      "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; organization?: Organization }',
    }),
  );
  const adapter = memoryAdapter();
  await adapter.connect(models);
  const repos = createRepositories(models, adapter) as unknown as Record<string, Repository<any>>;
  const acme = await repos.organizations!.create({ name: "acme", size: 10 });
  await repos.organizations!.create({ name: "globex", size: 20 });
  await repos.organizations!.create({ name: "empty", size: 5 });
  const ana = await repos.users!.create({ name: "ana", organization: acme.id });
  const stats = await repos.organizations!.where((o: any) => o.users.isEmpty(false).or(o.size.gte(20))).aggregate((o: any) => ({
    organizations: o.count(),
    withAna: o.count(o.users.contains(ana.id)),
    size: o.size.sum(),
  }));
  expect(stats).toEqual({ organizations: 2, withAna: 1, size: 30 });
});
