import { expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { alwaysHiddenPaths } from "./model.ts";
import { populateRecords } from "./populate.ts";
import { project } from "./projection.ts";
import { entity, field } from "./testing/entities.ts";

const member = entity("Member", [
  field({ name: "name", type: "string" }),
  field({ name: "password", type: "string", hidden: true }),
  field({ name: "nickname", type: "string", hiddenOn: ["read"] }),
  field({
    name: "profile",
    type: "object",
    fields: [
      { name: "bio", type: "string", optional: false },
      { name: "token", type: "string", optional: false, hidden: true },
    ],
  }),
]);
member.exposure.read = { include: ["id", "name", "profile", "nickname", "password"], exclude: ["nickname"] };
const team = entity("Team", [
  field({ name: "title", type: "string" }),
  field({ name: "members", type: "refArray", target: "Member", onDelete: "restrict" }),
  field({ name: "lead", type: "ref", target: "Member", onDelete: "restrict", optional: true }),
]);

test("populated records get their hidden fields and read exposure applied in one pass, as two passes did", async () => {
  const adapter = memoryAdapter();
  await adapter.connect([member, team]);
  const at = new Date("2026-01-01T00:00:00Z");
  const stored = [
    { id: "m1", name: "Ann", password: "p1", nickname: "a", profile: { bio: "hi", token: "t1" }, createdAt: at, updatedAt: at },
    { id: "m2", name: "Bea", password: "p2", nickname: "b", profile: { bio: "yo", token: "t2" }, createdAt: at, updatedAt: at },
  ];
  for (const record of stored) await adapter.insert(member, record);
  const [populated] = await populateRecords(
    team,
    [{ id: "t", title: "T", members: ["m2", "m1"], lead: "m1", createdAt: at, updatedAt: at }],
    ["members", "lead"],
    [member, team],
    adapter,
  );

  const twoPasses = (record: (typeof stored)[number]) =>
    project(project(record, { exclude: alwaysHiddenPaths(member.fields) }), member.exposure.read);
  // Same keys, same values, same order.
  expect(JSON.stringify(populated!.members)).toBe(JSON.stringify([twoPasses(stored[1]!), twoPasses(stored[0]!)]));
  expect(JSON.stringify(populated!.lead)).toBe(JSON.stringify(twoPasses(stored[0]!)));
  expect(populated!.lead).toEqual({ id: "m1", name: "Ann", profile: { bio: "hi" } });
});
