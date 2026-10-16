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
