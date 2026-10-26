import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositories,
  memoryAdapter,
  mongodbAdapter,
  postgresAdapter,
  sqliteAdapter,
  type DatabaseAdapter,
  type Repository,
} from "@quickservicets/core";
import ts from "typescript";
import { resetPostgresTables } from "../../../core/src/testing/postgres.ts";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const entities = {
  "entities/Organization.ts":
    'import type { Team } from "./Team";\nimport type { User } from "./User";\nexport type Organization = { name: string; members: User[]; teams?: Team[] }',
  "entities/Team.ts": 'import type { Organization } from "./Organization";\nexport type Team = { name: string; organization?: Organization }',
  "entities/User.ts": 'import type { Project } from "./Project";\nexport type User = { email: string; role: "admin" | "member"; age?: number; projects?: Project[] }',
  "entities/Project.ts": 'import type { User } from "./User";\nexport type Project = { name: string; lead?: User }',
};
const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, ...entities });
const models = parseProjectEntities(root);

const factories: [string, () => DatabaseAdapter][] = [
  ["memory", () => memoryAdapter()],
  // An adapter without related queries gets the same results from the owner's array.
  ["memory without related queries", () => ({ ...memoryAdapter(), findRelated: undefined, countRelated: undefined, aggregateRelated: undefined })],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_related_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

describe.each(factories)("%s", (_, factory) => {
  async function setup() {
    const adapter = factory();
    await adapter.connect(models);
    const client = (adapter as unknown as { client: never }).client;
    if (adapter.kind === "sqlite") await createSqliteTables(client, models);
    if (adapter.kind === "postgres") await resetPostgresTables(client, models);
    const repos = createRepositories(models, adapter) as unknown as Record<string, Repository<any, any>>;
    const ana = await repos.users!.create({ email: "ana@acme.com", role: "admin", age: 30 });
    const bob = await repos.users!.create({ email: "bob@acme.com", role: "member", age: 20 });
    const cid = await repos.users!.create({ email: "cid@acme.com", role: "member" });
    await repos.users!.create({ email: "dee@globex.com", role: "admin", age: 50 });
    await repos.projects!.create({ name: "website", lead: bob.id });
    const acme = await repos.organizations!.create({ name: "acme", members: [ana.id, bob.id, cid.id] });
    const empty = await repos.organizations!.create({ name: "empty" });
    /** The SQL statements PostgreSQL runs while `run` does. */
    const statements = async (run: () => Promise<unknown>) => {
      const sent: string[] = [];
      if (adapter.kind !== "postgres") return { result: await run(), sent };
      const sql = (adapter as unknown as { client: { unsafe(query: string, params?: unknown[]): unknown } }).client;
      const unsafe = sql.unsafe;
      sql.unsafe = (query, params) => (sent.push(query), unsafe.call(sql, query, params));
      try {
        return { result: await run(), sent };
      } finally {
        sql.unsafe = unsafe;
      }
    };
    return { adapter, repos, ana, bob, acme, empty, statements };
  }
  const stats = (organizations: Repository<any, any>, id: string) =>
    organizations
      .related(id, "members")
      .aggregate((u: any) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));

  test("aggregate runs in one statement, is null for a missing owner and 0 or null over an empty array", async () => {
    const { adapter, repos, acme, empty, statements } = await setup();
    const { result, sent } = await statements(() => stats(repos.organizations!, acme.id));
    expect(result).toEqual({ members: 3, admins: 1, averageAge: 25 });
    if (adapter.kind === "postgres") expect(sent).toHaveLength(1);
    expect(await stats(repos.organizations!, Bun.randomUUIDv7())).toBeNull();
    expect(await stats(repos.organizations!, empty.id)).toEqual({ members: 0, admins: 0, averageAge: null });
    await adapter.disconnect();
  });

  test("where, count and the other terminals, with conditions on derived sides", async () => {
    const { adapter, repos, ana, bob, acme } = await setup();
    const members = repos.organizations!.related(acme.id, "members");
    const admins = members.where((u: any) => u.role.eq("admin"));
    expect((await admins.toArray()).map((user: any) => user.id)).toEqual([ana.id]);
    expect(await admins.count()).toBe(1);
    const leads = members.where((u: any) => u.projects.isEmpty(false));
    expect((await leads.toArray()).map((user: any) => [user.email, user.projects.length])).toEqual([["bob@acme.com", 1]]);
    expect(((await leads.first()) as { id: string }).id).toBe(bob.id);
    expect(await members.aggregate((u: any) => ({ leadsOrAdmins: u.count(u.projects.isEmpty(false).or(u.role.eq("admin"))) }))).toEqual({ leadsOrAdmins: 2 });
    expect(await leads.aggregate((u: any) => ({ leads: u.count(), averageAge: u.age.avg() }))).toEqual({ leads: 1, averageAge: 20 });
    await adapter.disconnect();
  });

  test("only stored reference arrays can be followed", async () => {
    const { adapter, repos, acme } = await setup();
    expect(() => repos.organizations!.related(acme.id, "teams")).toThrow('related() follows the stored reference arrays of Organization, and "teams" is not one');
    expect(() => repos.organizations!.related(acme.id, "name")).toThrow('related() follows the stored reference arrays of Organization, and "name" is not one');
    await adapter.disconnect();
  });
});

test("related queries are typed by the generated repositories", async () => {
  await build(root);
  const check = join(root, "check.ts");
  writeFileSync(
    check,
    `import type { GeneratedRepositories, Project, User } from "./.generated/types.ts";
declare const repos: GeneratedRepositories;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const expect = <T extends true>() => {};
export async function run(id: string) {
  const stats = await repos.organizations.related(id, "members").aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
  expect<Equal<typeof stats, { members: number; admins: number; averageAge: number | null } | null>>();
  const admins: User[] = await repos.organizations.related(id, "members").where((u) => u.role.eq("admin")).toArray();
  const count: number = await repos.organizations.related(id, "members").where((u) => u.projects.isEmpty(false)).count();
  const [first] = await repos.organizations.related(id, "members").include("projects").toArray();
  const projects: Project[] | undefined = first?.projects;
  // aggregate is nullable after every chained call, since the owner may be missing.
  // @ts-expect-error possibly null
  const members: number = (await repos.organizations.related(id, "members").orderBy((u) => u.email).aggregate((u) => ({ n: u.count() }))).n;
  // @ts-expect-error not a reference array
  repos.organizations.related(id, "name");
  // @ts-expect-error the derived side of a relation
  repos.organizations.related(id, "teams");
  // @ts-expect-error unknown field of the target
  repos.organizations.related(id, "members").where((u) => u.name.eq("x"));
  return [admins, count, projects, members];
}
`,
  );
  const program = ts.createProgram([check], {
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
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});
