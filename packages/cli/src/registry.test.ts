import { afterEach, describe, expect, test } from "bun:test";
import { boolean, defineCommand, defineFeature, integer, object, registerNative, registerProjectFeatures, type CommandDefinition } from "@quickservice/core";
import { unregisterNative } from "../../core/src/features.ts";
import { cliPage } from "../../../docs/scripts/reference.ts";
import { build } from "./build/build.ts";
import { BUILT_IN_COMMANDS, COMMANDS } from "./commands.ts";
import { loadFeatureCommands, resolveCommand } from "./registry.ts";
import { run } from "./run.ts";
import { createLinkedProject } from "./testing/project.ts";

const config = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const project = (keys = "example: {}", files: Record<string, string> = {}) => createLinkedProject({ "quickservice.config.ts": config(keys), ...files });
const capture = async (args: string[], root: string, loader?: Parameters<typeof run>[3]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root, loader);
  return { code, out, err };
};

const hello = defineCommand({
  name: "example hello",
  usage: "quickservice example hello <name> [--loud] [--count n]",
  description: "Greets someone.",
  args: [{ name: "name", required: true, description: "Who to greet." }],
  flags: object({ loud: boolean().default(false).describe("Shouts the greeting."), count: integer().optional() }),
  run: ({ args, flags, output }) => {
    const text = `Hello, ${args.name}!`;
    for (let index = 0; index < (flags.count ?? 1); index++) output.log(flags.loud ? text.toUpperCase() : text);
  },
});
const registered: string[] = [];
const native = (key: string, commands: CommandDefinition[], extra: Record<string, unknown> = {}) => {
  registerNative(defineFeature({ key, commands, ...extra }));
  registered.push(key);
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
  registerProjectFeatures([]);
});

describe("definitions and the built-in registry", () => {
  test("defineCommand checks names and keeps its fields", () => {
    expect(hello.words).toEqual(["example", "hello"]);
    expect(hello.args).toEqual([{ name: "name", required: true, description: "Who to greet." }]);
    expect(() => defineCommand({ name: "Example", usage: "u", description: "d", run: () => {} })).toThrow("Invalid command Example: each word must match ^[a-z][a-z0-9-]*$");
    expect(() => defineCommand({ name: "x", usage: "u", description: "d", flags: integer() as never, run: () => {} })).toThrow("flags must be an object({...}) schema");
  });

  test("every built-in command is defined in the registry, and the reference list derives from it", () => {
    expect(BUILT_IN_COMMANDS.map((command) => command.name)).toEqual([
      "init", "dev", "build", "migrate", "migration add", "migration list", "migration remove", "migration script", "job run", "job list", "job runs", "env check",
    ]);
    expect(COMMANDS.map((command) => command.name)).toEqual([...BUILT_IN_COMMANDS.map((command) => command.name), "--version"]);
  });
});

describe("dispatch", () => {
  test("a feature command runs with its positional arguments and typed flags", async () => {
    native("example", [hello]);
    const root = project();
    expect(await capture(["example", "hello", "Ana"], root)).toEqual({ code: 0, out: ["Hello, Ana!"], err: [] });
    expect((await capture(["example", "hello", "Ana", "--loud"], root)).out).toEqual(["HELLO, ANA!"]);
    expect((await capture(["example", "hello", "--no-loud", "Ana"], root)).out).toEqual(["Hello, Ana!"]);
    expect((await capture(["example", "hello", "Ana", "--loud=false", "--count", "2"], root)).out).toEqual(["Hello, Ana!", "Hello, Ana!"]);
  });

  test("built-in commands never load the config to be found; feature commands match the longest name", async () => {
    let loads = 0;
    const loader = async (cwd: string) => (loads++, loadFeatureCommands(cwd));
    native("example", [hello, defineCommand({ name: "example", usage: "quickservice example", description: "The short one.", run: ({ output }) => output.log("short") })]);
    const root = project();
    expect((await capture(["build"], root, loader)).code).toBe(0);
    expect(loads).toBe(0);
    expect((await resolveCommand(["migration", "list"], root, loader)).resolved!.command.name).toBe("migration list");
    expect(loads).toBe(0);
    expect((await capture(["example", "hello", "Ana"], root, loader)).out).toEqual(["Hello, Ana!"]);
    expect((await capture(["example"], root, loader)).out).toEqual(["short"]);
    expect(loads).toBe(2);
  });

  test("a disabled feature's commands are unknown", async () => {
    native("example", [hello]);
    const { code, err } = await capture(["example", "hello", "Ana"], project(""));
    expect([code, err]).toEqual([1, ["Unknown command: example"]]);
  });
});

describe("conflicts", () => {
  test("a feature command named like a built-in or another feature's command fails before anything runs", async () => {
    let ran = false;
    native("example", [defineCommand({ name: "migrate", usage: "u", description: "d", run: () => void (ran = true) })]);
    expect(await capture(["example", "hello"], project())).toEqual({ code: 1, out: [], err: ['Command "migrate" of example conflicts with the built-in command'] });
    unregisterNative("example");
    registered.splice(0);
    native("example", [hello]);
    native("other", [hello]);
    expect((await capture(["example", "hello", "Ana"], project("example: {}, other: {}"))).err).toEqual(['Command "example hello" of other conflicts with example']);
    expect(ran).toBe(false);
  });
});

describe("arguments and flags", () => {
  test("unknown flags, missing arguments and invalid values print the error and the usage", async () => {
    native("example", [hello]);
    const root = project();
    const usage = "Usage: quickservice example hello <name> [--loud] [--count n]";
    expect(await capture(["example", "hello", "Ana", "--shout"], root)).toEqual({ code: 1, out: [], err: ["Unknown flag --shout", usage] });
    expect(await capture(["example", "hello", "Ana", "--lowd"], root)).toEqual({ code: 1, out: [], err: ["Unknown flag --lowd (did you mean --loud?)", usage] });
    expect(await capture(["example", "hello"], root)).toEqual({ code: 1, out: [], err: ["Missing argument <name>", usage] });
    expect(await capture(["example", "hello", "Ana", "--count=x"], root)).toEqual({ code: 1, out: [], err: ['Invalid --count: expected an integer, got "x"', usage] });
    expect(await capture(["example", "hello", "Ana", "--count"], root)).toEqual({ code: 1, out: [], err: ["Missing value for --count", usage] });
  });

  test("an error thrown by run prints its message and exits 1", async () => {
    native("example", [defineCommand({ name: "example fail", usage: "quickservice example fail", description: "Fails.", run: () => { throw new Error("broker unreachable"); } })]);
    expect(await capture(["example", "fail"], project())).toEqual({ code: 1, out: [], err: ["broker unreachable"] });
  });
});

describe("help", () => {
  test("help lists the built-in commands, then each enabled feature's under its key", async () => {
    native("example", [hello]);
    const root = project();
    for (const args of [["help"], ["--help"]]) {
      const { code, out } = await capture(args, root);
      expect(code).toBe(0);
      expect(out[0]).toBe("Usage: quickservice <command> [arguments] [flags]");
      expect(out.findIndex((line) => line.startsWith("  build "))).toBeGreaterThan(0);
      const group = out.indexOf("example:");
      expect(group).toBeGreaterThan(out.findIndex((line) => line.startsWith("  env check")));
      expect(out[group + 1]).toMatch(/^ {2}example hello +Greets someone\.$/);
    }
  });

  test("a command's --help shows its usage, arguments and flags with defaults", async () => {
    native("example", [hello]);
    const { code, out } = await capture(["example", "hello", "--help"], project());
    expect(code).toBe(0);
    expect(out).toEqual([
      "Usage: quickservice example hello <name> [--loud] [--count n]",
      "",
      "Greets someone.",
      "",
      "Arguments:",
      "  name (required)  Who to greet.",
      "",
      "Flags:",
      "  --loud  boolean (default false)  Shouts the greeting.",
      "  --count  integer",
    ]);
    expect((await capture(["migrate", "--help"], project(""))).out).toContain("  --force  boolean (default false)  Reverts migrations in production.");
  });

  test("an unknown command suggests the closest one", async () => {
    const root = project("");
    expect(await capture(["biuld"], root)).toEqual({ code: 1, out: [], err: ["Unknown command: biuld", "Did you mean build?"] });
    expect((await capture(["migration", "ad"], root)).err).toEqual(["Unknown command: migration ad", "Did you mean migration add?"]);
    expect((await capture(["frobnicate"], root)).err).toEqual(["Unknown command: frobnicate"]);
  });
});

describe("connect", () => {
  test("ctx.connect gives repositories of the generated models and disconnects after run", async () => {
    let disconnected = 0;
    native("example", [
      defineCommand({
        name: "example seed",
        usage: "quickservice example seed",
        description: "Seeds a post.",
        async run({ connect, config, output }) {
          const database = config.database as { disconnect(): Promise<void> };
          const original = database.disconnect.bind(database);
          database.disconnect = async () => (disconnected++, original());
          const repos = (await connect()) as unknown as { posts: { create(data: object): Promise<{ title: string }>; query(): { count(): Promise<number> } } };
          output.log((await repos.posts.create({ title: "Seeded" })).title);
          output.log(String(await repos.posts.query().count()));
          expect(disconnected).toBe(0);
        },
      }),
    ]);
    const root = project("example: {}", { "entities/Post.ts": "export type Post = { title: string };\n" });
    await build(root);
    expect(await capture(["example", "seed"], root)).toEqual({ code: 0, out: ["Seeded", "1"], err: [] });
    expect(disconnected).toBe(1);
  });
});

describe("reference", () => {
  test("the CLI reference lists the commands of registered natives under their key", () => {
    native("example", [hello]);
    const page = cliPage();
    const section = page.slice(page.indexOf("## Commands of native features"));
    expect(section).toContain("### `example`\n\n#### `example hello`\n\nGreets someone.\n\n```bash\nquickservice example hello <name> [--loud] [--count n]\n```");
    expect(section).toContain("- `<name>` (required): Who to greet.");
    expect(section).toContain("- `--loud` (`boolean`, default `false`): Shouts the greeting.");
  });
});
