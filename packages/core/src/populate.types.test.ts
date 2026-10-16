import { expect, test } from "bun:test";
import type { Repository } from "./repository.ts";

type Organization = { id: string; createdAt: Date; updatedAt: Date; name: string };
type User = { id: string; createdAt: Date; updatedAt: Date; email: string; organization: string; teams: string[] };

// Type-level checks: this function is compiled by tsc but never called.
async function typed(users: Repository<User, { organization: Organization | null; teams: Organization[] }>) {
  const plain = await users.findById("x");
  const id: string | undefined = plain?.organization;
  const populated = await users.findById("x", { populate: ["organization"] });
  const organization: Organization | null | undefined = populated?.organization;
  // @ts-expect-error a populated reference is no longer a string
  const wrong: string | undefined = populated?.organization;
  const listed = await users.list({ where: [], sort: [], limit: 1, offset: 0 }, { populate: ["organization"] });
  const first: Organization | null | undefined = listed.data[0]?.organization;
  const withTeams = await users.findById("x", { populate: ["teams"] });
  const teams: Organization[] | undefined = withTeams?.teams;
  return [id, organization, wrong, first, teams];
}

test("populated reads are typed with the referenced record", () => {
  expect(typed).toBeDefined();
});
