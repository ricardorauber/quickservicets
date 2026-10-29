import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, defineCommand, jsonShapeProblems, registeredNatives, type CommandDefinition, type JsonFields } from "@quickservicets/core";
import { BUILT_IN_COMMANDS } from "./commands.ts";
import { classifyError, EXIT_CODE_MEANINGS, isDatabaseUnreachable, isInteractive, NotInteractiveError, runCommand, UsageError, type CommandIO } from "./registry.ts";
import { run } from "./run.ts";
import { createLinkedProject, createProject } from "./testing/project.ts";

/** Runs `quickservicets <args>` in `cwd`, collecting stdout and stderr lines. */
async function cli(args: string[], cwd: string, io: CommandIO = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, cwd, undefined, io);
  return { code, out, err };
}

const allCommands = (): CommandDefinition[] => [...BUILT_IN_COMMANDS, ...registeredNatives().flatMap((native) => native.commands ?? [])];
const shapeOf = (name: string): JsonFields => allCommands().find((command) => command.name === name)!.json!;

/** The one JSON document a `--json` run printed, checked against the command's documented shape. */
function documentOf(name: string, result: { code: number; out: string[] }): Record<string, unknown> {
  expect(result.out.length).toBe(1);
  const document = JSON.parse(result.out[0]!) as Record<string, unknown>;
  const { ok, ...fields } = document;
  expect(ok).toBe(true);
  expect(jsonShapeProblems(fields, shapeOf(name))).toEqual([]);
  expect(result.code).toBe(0);
  return document;
}

const root = createLinkedProject({
  "entities/Task.ts": "export type Task = { title: string };\n",
  "jobs/report.ts": 'import { job } from "@quickservicets/core";\nexport default job("@daily", async () => ({ done: true }));\n',
  "queues/email.ts": 'import { queue } from "@quickservicets/core";\nexport default queue<{ to: string }>(async () => {});\n',
});
await Bun.write(
  join(root, "quickservicets.config.ts"),
  `import { defineConfig, integer, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({
  database: sqliteAdapter({ path: ${JSON.stringify(join(root, "data.db"))} }),
  env: { REPORT_HOUR: integer().default(6) },
  events: { outbox: true },
  queues: {},
  flags: { rules: { beta: { users: ["u1"], percentage: 10 } } },
});
`,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("--json output", () => {
  test("every listed command declares its JSON shape", () => {
    const listed = ["build", "migration add", "migration list", "migrate", "job list", "job runs", "env check", "queue list", "queue dead", "flags list", "events outbox"];
    for (const name of listed) expect(shapeOf(name)).toBeDefined();
    expect(BUILT_IN_COMMANDS.find((command) => command.name === "eject")!.json).toBeUndefined();
  });

  test("each command prints one document matching its shape, with the logs on stderr", async () => {
    const build = documentOf("build", await cli(["build", "--json"], root));
    expect(build).toMatchObject({ endpoints: 0, buildSteps: ["flags"], warnings: [expect.stringContaining("migration add")] });

    const added = await cli(["migration", "add", "Init", "--json"], root);
    expect(documentOf("migration add", added).file).toMatch(/^migrations\/\d+_Init\.ts$/);
    expect(added.err.some((line) => line.startsWith("Created migrations/"))).toBe(true);

    const pending = documentOf("migration list", await cli(["migration", "list", "--json"], root));
    expect(pending.migrations).toEqual([{ id: expect.stringMatching(/_Init$/), status: "pending", schemas: [] }]);

    const migrated = await cli(["migrate", "--json"], root);
    expect(documentOf("migrate", migrated).applied).toEqual([expect.stringMatching(/_Init$/)]);
    expect(migrated.err.some((line) => line.startsWith("Applied "))).toBe(true);

    expect(documentOf("job list", await cli(["job", "list", "--json"], root)).jobs).toEqual([{ name: "report", schedule: "@daily", timeZone: "UTC", nextRun: expect.any(String) }]);
    expect((await cli(["job", "run", "report"], root)).code).toBe(0);
    const runs = documentOf("job runs", await cli(["job", "runs", "report", "--json"], root));
    expect(runs).toMatchObject({ job: "report", runs: [{ attempt: 1, trigger: "manual", status: "success" }] });

    expect(documentOf("env check", await cli(["env", "check", "--json"], root)).variables).toEqual([{ name: "REPORT_HOUR", status: "default", value: "6" }]);
    expect(documentOf("queue list", await cli(["queue", "list", "--json"], root)).queues).toEqual([{ name: "email", waiting: 0, active: 0, completed: 0, dead: 0, oldestWaiting: null }]);
    expect(documentOf("queue dead", await cli(["queue", "dead", "email", "--json"], root))).toEqual({ ok: true, queue: "email", messages: [] });
    expect(documentOf("flags list", await cli(["flags", "list", "--json"], root)).flags).toEqual([{ name: "beta", origin: "config", enabled: true, users: 1, tenants: 0, percentage: 10 }]);
    expect(documentOf("events outbox", await cli(["events", "outbox", "--json"], root))).toEqual({ ok: true, consumers: [] });
    expect(documentOf("agents update", await cli(["agents", "update", "--json"], root)).changed).toContain("AGENTS.md");
  }, 120_000);

  test("without --json the output is unchanged, and a command without json refuses --json as a usage error", async () => {
    const plain = await cli(["migration", "list"], root);
    expect(plain.out).toEqual([expect.stringMatching(/_Init {2}applied$/)]);
    const refused = await cli(["eject", "flags", "--json"], root);
    expect(refused.code).toBe(2);
    expect(refused.err[0]).toBe("Unknown flag --json");
  });

  test("the shape check reports missing, mistyped and undocumented fields", () => {
    const shape: JsonFields = { name: "string", count: "number", note: "string?", items: [{ id: "string" }] };
    expect(jsonShapeProblems({ name: "a", count: 1, items: [{ id: "x" }] }, shape)).toEqual([]);
    expect(jsonShapeProblems({ name: 1, items: [{}], extra: true }, shape)).toEqual([
      "$.name: expected string, got number",
      "$.count: missing number",
      "$.items[0].id: missing string",
      "$.extra: not in the shape",
    ]);
  });
});

describe("prompts when not interactive", () => {
  const asking = (fallback?: string) =>
    defineCommand({
      name: "pick",
      usage: "quickservicets pick",
      description: "Asks for a color.",
      json: { color: "string" },
      async run({ prompt, output, result }) {
        const color = await prompt("Which color?", ["red", "blue"], { flag: "--color", ...(fallback ? { default: fallback } : {}) });
        output.log(color);
        result({ color });
      },
    });
  const capture = async (command: CommandDefinition, rest: string[], io: CommandIO) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCommand({ command }, rest, createProject({}), { log: (line) => out.push(line), error: (line) => err.push(line) }, io);
    return { code, out, err };
  };

  test("init without --db takes the memory database without a question, interactive or not", async () => {
    for (const interactive of [false, true]) {
      const parent = createProject({});
      const result = await cli(["init", "demo"], parent, { interactive, ask: async () => "sqlite" });
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      expect(readFileSync(join(parent, "demo/quickservicets.config.ts"), "utf8")).toContain("in-memory database");
    }
  });

  test("an interactive terminal is asked, and --yes takes the safe answer instead", async () => {
    const ask = async () => "blue";
    expect((await capture(asking("red"), [], { interactive: true, ask })).out).toEqual(["blue"]);
    expect((await capture(asking("red"), ["--yes"], { interactive: true, ask })).out).toEqual(["red"]);
    expect((await capture(asking("red"), [], { interactive: false, ask })).out).toEqual(["red"]);
  });

  test("a question without a safe answer exits 2 naming the flag, also with --json", async () => {
    expect(await capture(asking(), [], { interactive: false })).toEqual({ code: 2, out: [], err: ["pick needs --color when not interactive"] });
    expect(await capture(asking(), ["--yes", "--json"], { interactive: true, ask: async () => "blue" })).toEqual({
      code: 2,
      out: ['{"ok":false,"error":{"code":"NOT_INTERACTIVE","message":"pick needs --color when not interactive"}}'],
      err: [],
    });
  });

  test("CI=true and a stdin that is not a terminal make the CLI non-interactive", () => {
    expect(isInteractive({ CI: "true" })).toBe(false);
    if (!process.stdin.isTTY) expect(isInteractive({})).toBe(false);
  });
});

describe("exit codes", () => {
  test("map errors to 1 failure, 2 usage, 3 configuration and 4 database unreachable", () => {
    expect(EXIT_CODE_MEANINGS.map(([code]) => code)).toEqual([0, 1, 2, 3, 4]);
    expect(classifyError(new Error("boom"))).toEqual({ exit: 1, code: "FAILED" });
    expect(classifyError(new UsageError("Unknown flag --x"))).toEqual({ exit: 2, code: "USAGE_ERROR" });
    expect(classifyError(new NotInteractiveError("init", "--db"))).toEqual({ exit: 2, code: "NOT_INTERACTIVE" });
    expect(classifyError(new ConfigError("Invalid QS_SERVER_PORT"))).toEqual({ exit: 3, code: "CONFIG_ERROR" });
    const refused = Object.assign(new Error("Failed to connect"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" });
    expect(classifyError(refused)).toEqual({ exit: 4, code: "DATABASE_UNREACHABLE" });
    expect(isDatabaseUnreachable(new Error("wrapped", { cause: Object.assign(new Error("x"), { name: "MongoServerSelectionError" }) }))).toBe(true);
    expect(isDatabaseUnreachable(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
  });

  test("a usage error exits 2, a config error 3 and an unreachable database 4, with { ok: false, error } under --json", async () => {
    expect((await cli(["frobnicate"], root)).code).toBe(2);
    expect(await cli(["frobnicate", "--json"], root)).toEqual({ code: 2, out: ['{"ok":false,"error":{"code":"USAGE_ERROR","message":"Unknown command: frobnicate"}}'], err: [] });

    const invalid = createProject({ "quickservicets.config.ts": "export default 42;\n" });
    expect((await cli(["build"], invalid)).code).toBe(3);
    const config = await cli(["build", "--json"], invalid);
    expect(config.code).toBe(3);
    expect(JSON.parse(config.out[0]!)).toMatchObject({ ok: false, error: { code: "CONFIG_ERROR" } });
    expect(JSON.parse(config.out[0]!).error.message).toContain(join(invalid, "quickservicets.config.ts"));

    const unreachable = createLinkedProject({
      "entities/Task.ts": "export type Task = { title: string };\n",
      "quickservicets.config.ts": 'import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: "postgres://u:p@127.0.0.1:1/app" }) });\n',
    });
    expect((await cli(["build"], unreachable)).code).toBe(0);
    expect((await cli(["migration", "add", "Init"], unreachable)).code).toBe(0);
    expect((await cli(["migrate"], unreachable)).code).toBe(4);
    const down = await cli(["migrate", "--json"], unreachable);
    expect(down.code).toBe(4);
    expect(JSON.parse(down.out[0]!)).toMatchObject({ ok: false, error: { code: "DATABASE_UNREACHABLE" } });
    rmSync(unreachable, { recursive: true, force: true });
  }, 60_000);

  test("a failed operation exits 1 with { ok: false } and its fields under --json", async () => {
    const missing = createLinkedProject({
      "quickservicets.config.ts": 'import { defineConfig, memoryAdapter, string } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), env: { API_KEY: string() } });\n',
    });
    const result = await cli(["env", "check", "--json"], missing);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.out[0]!);
    expect(document).toMatchObject({ ok: false, error: { code: "FAILED" }, variables: [{ name: "API_KEY", status: "missing" }] });
    expect(existsSync(missing)).toBe(true);
    rmSync(missing, { recursive: true, force: true });
  });
});
