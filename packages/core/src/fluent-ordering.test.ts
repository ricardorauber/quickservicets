import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import type { EntityModel } from "./model.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const user = entity("User", [
  field({ name: "email", type: "string" }),
  field({ name: "rank", type: "number" }),
  field({ name: "teams", type: "refArray", target: "User", onDelete: "pull", optional: true }),
]);
const models: EntityModel[] = [user];

type UserRecord = { id: string; createdAt: Date; updatedAt: Date; email: string; rank: number; teams: string[] };

const factories: [string, () => DatabaseAdapter][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_order_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

async function setup(factory: () => DatabaseAdapter, findAllMax?: number) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  const users = (createRepositories(models, adapter, { findAllMax }) as Record<string, Repository>).users as unknown as Repository<UserRecord>;
  for (const [email, rank] of [["c@x.co", 2], ["a@x.co", 1], ["e@x.co", 2], ["b@x.co", 3], ["d@x.co", 1]] as const) {
    await users.create({ email, rank });
  }
  return { adapter, users };
}

const emails = (records: { email: string }[]) => records.map((record) => record.email);

describe.each(factories)("%s", (_, factory) => {
  test("ordering by one and several fields, both directions", async () => {
    const { adapter, users } = await setup(factory);
    expect(emails(await users.query().orderBy((u) => u.email).all())).toEqual(["a@x.co", "b@x.co", "c@x.co", "d@x.co", "e@x.co"]);
    expect(emails(await users.query().orderByDescending((u) => u.email).all())).toEqual(["e@x.co", "d@x.co", "c@x.co", "b@x.co", "a@x.co"]);
    expect(emails(await users.query().orderByDescending((u) => u.rank).thenBy((u) => u.email).all())).toEqual([
      "b@x.co",
      "c@x.co",
      "e@x.co",
      "a@x.co",
      "d@x.co",
    ]);
    expect(emails(await users.query().orderBy((u) => u.rank).thenByDescending((u) => u.email).all())).toEqual([
      "d@x.co",
      "a@x.co",
      "e@x.co",
      "c@x.co",
      "b@x.co",
    ]);
    await adapter.disconnect();
  });

  test("skip and take slice every terminal but count and any", async () => {
    const { adapter, users } = await setup(factory);
    const sliced = users.query().orderBy((u) => u.email).skip(1).take(2);
    expect(emails(await sliced.all())).toEqual(["b@x.co", "c@x.co"]);
    expect((await sliced.first()).email).toBe("b@x.co");
    expect((await sliced.firstOrDefault())?.email).toBe("b@x.co");
    expect(await sliced.count()).toBe(5);
    expect(await sliced.any()).toBe(true);
    const page = await sliced.page({ limit: 5 });
    expect(emails(page.data)).toEqual(["b@x.co", "c@x.co"]);
    expect(page.total).toBe(5);
    expect(await users.query().take(0).firstOrDefault()).toBeNull();
    expect(() => users.query().skip(-1)).toThrow("Invalid query");
    await adapter.disconnect();
  });

  test("the cap applies after slicing", async () => {
    const { adapter, users } = await setup(factory, 2);
    expect(await users.query().take(2).all()).toHaveLength(2);
    expect(await users.query().skip(3).all()).toHaveLength(2);
    await expect(users.query().all()).rejects.toThrow("Query on User matched more than repositories.findAllMax (2) records");
    await adapter.disconnect();
  });

  test("select returns only the fields and the id", async () => {
    const { adapter, users } = await setup(factory);
    const [first] = await users.query().orderBy((u) => u.email).select("email").all();
    expect(Object.keys(first!).sort()).toEqual(["email", "id"]);
    expect(first!.email).toBe("a@x.co");
    await adapter.disconnect();
  });
});

test("unsortable fields throw at runtime", () => {
  const users = (createRepositories(models, memoryAdapter()) as Record<string, Repository>).users!;
  expect(() => users.query().orderBy((u: any) => u.teams)).toThrow('User cannot be ordered by "teams"');
});

test("types reject unsortable and unknown fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-order-"));
  const file = join(dir, "check.ts");
  writeFileSync(
    file,
    `import type { Repository } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
type User = { id: string; createdAt: Date; updatedAt: Date; email: string; rank: number; teams: string[]; address?: { city: string } };
declare const users: Repository<User>;
users.query().orderBy((u) => u.email).thenByDescending((u) => u.createdAt);
// @ts-expect-error reference arrays cannot be ordered
users.query().orderBy((u) => u.teams);
// @ts-expect-error objects cannot be ordered
users.query().orderBy((u) => u.address);
export async function picked() {
  const [record] = await users.query().select("email").all();
  const email: string = record!.email;
  const id: string = record!.id;
  // @ts-expect-error not selected
  void record!.rank;
  return email + id;
}
// @ts-expect-error unknown field
users.query().select("emial");
`,
  );
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(file));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});
