import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { DATABASES } from "../init/init.ts";
import { END_MARKER, GENERATED_HEADER, PROJECT_SKILL_DIR, projectAgentFiles, projectInfo } from "./project.ts";
import { SKILL_RULES, skillProblems } from "./skill.ts";
import { TOPIC_NAMES } from "./topics.ts";

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

/** Runs `quickservicets <args>` in `cwd`, collecting what it prints. */
async function cli(args: string[], cwd: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { log: (line) => logs.push(line), error: (line) => errors.push(line) }, cwd);
  return { code, logs, errors };
}

/** A new project made by `quickservicets init demo` with the given flags, and its folder. */
async function init(...flags: string[]): Promise<string> {
  const parent = createProject({});
  expect((await cli(["init", "demo", ...flags], parent)).code).toBe(0);
  return join(parent, "demo");
}

const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", `${PROJECT_SKILL_DIR}/SKILL.md`, ...TOPIC_NAMES.map((name) => `${PROJECT_SKILL_DIR}/topics/${name}.md`)];

describe("project AGENTS.md", () => {
  test.each([
    ["sqlite", "SQLite"],
    ["postgres", "PostgreSQL"],
    ["mongodb", "MongoDB"],
    ["memory", "the in-memory database"],
  ])("names the database, the commands of package.json, the folders, the rules and the links (%s)", async (db, name) => {
    const root = await init("--db", db);
    const agents = read(root, "AGENTS.md");
    expect(agents.split("\n")[0]).toBe(GENERATED_HEADER);
    expect(agents).toContain(`# demo\n\n\`demo\` is a QuickService.ts service on ${name}:`);
    const scripts = JSON.parse(read(root, "package.json")).scripts as Record<string, string>;
    for (const script of ["dev", "build", "typecheck", "start"]) expect(agents).toContain(`- \`bun run ${script}\` (\`${scripts[script]}\`)`);
    expect(agents).toContain("- `bun test`:");
    if (db === "memory") {
      expect(agents.split("## Folders")[0]).not.toContain("migration add");
      expect(agents).toContain("No migrations");
    } else {
      expect(agents).toContain("- `bun run quickservicets migration add <Name>`:");
      expect(agents).toContain("- `bun run migrate` (`quickservicets migrate`):");
      expect(agents).toContain("- `migrations/`:");
    }
    for (const folder of ["entities/", "endpoints/", "hooks/", "jobs/", "features/", ".generated/"]) expect(agents).toContain(`- \`${folder}\`: `);
    for (const rule of SKILL_RULES) expect(agents).toContain(`- ${rule}\n`);
    expect(agents).toContain("[/llms.txt](/llms.txt)");
    expect(agents).toContain(`[quickstart](${PROJECT_SKILL_DIR}/topics/quickstart.md)`);
    expect(agents.trimEnd().endsWith(END_MARKER)).toBe(true);
  });

  test("reads the project's name, database and scripts", () => {
    const root = createProject({ "package.json": '{"name":"shop","scripts":{"dev":"quickservicets dev"}}', "quickservicets.config.ts": "export default defineConfig({ database: postgresAdapter({ url }) });" });
    expect(projectInfo(root)).toEqual({ name: "shop", database: "postgres", scripts: { dev: "quickservicets dev" } });
    expect(projectAgentFiles({ name: "shop", scripts: {} })["AGENTS.md"]).toContain("on the database set in `quickservicets.config.ts`");
  });

  test("a project without a config file or without database runs on memory, even with a commented adapter", () => {
    expect(projectInfo(createProject({ "package.json": '{"name":"tiny"}' })).database).toBe("memory");
    const commented = "// database: sqliteAdapter({ path: env.DATABASE_PATH }),\nexport default defineConfig({});\n";
    expect(projectInfo(createProject({ "quickservicets.config.ts": commented })).database).toBe("memory");
    const url = 'export default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }) });';
    expect(projectInfo(createProject({ "quickservicets.config.ts": url })).database).toBe("postgres");
  });
});

describe("CLAUDE.md and the skill", () => {
  test("CLAUDE.md imports AGENTS.md, and the skill and its topics are copied with the header and the marker", async () => {
    const root = await init("--db", "sqlite");
    expect(read(root, "CLAUDE.md")).toBe(`${GENERATED_HEADER}\n@AGENTS.md\n${END_MARKER}\n`);
    const skill = read(root, `${PROJECT_SKILL_DIR}/SKILL.md`);
    expect(skill).toStartWith("---\nname: quickservicets\n");
    expect(skill).toContain(`\n---\n${GENERATED_HEADER}\n`);
    expect(skillProblems(skill)).toEqual([]);
    expect(readdirSync(join(root, PROJECT_SKILL_DIR, "topics")).sort()).toEqual(TOPIC_NAMES.map((name) => `${name}.md`).sort());
    const quickstart = read(root, `${PROJECT_SKILL_DIR}/topics/quickstart.md`);
    expect(quickstart.split("\n")[0]).toBe(GENERATED_HEADER);
    expect(quickstart).toContain("# Quickstart");
    for (const file of AGENT_FILES) expect(read(root, file).trimEnd().endsWith(END_MARKER)).toBe(true);
  });
});

describe("--no-agents", () => {
  test("writes none of the agent files", async () => {
    const root = await init("--no-agents", "--db", "memory");
    for (const file of [...AGENT_FILES, ".claude"]) expect(existsSync(join(root, file))).toBe(false);
    expect(existsSync(join(root, "quickservicets.config.ts"))).toBe(true);
  });
});

describe("agents update", () => {
  test("refreshes the generated part, keeps the lines below the marker and prints the files that changed", async () => {
    const root = await init("--db", "sqlite");
    const fresh = read(root, "AGENTS.md");
    writeFileSync(join(root, "AGENTS.md"), `${fresh.replace("# demo", "# old title")}\n## Our notes\n\nAsk Ana before changing billing.\n`);
    writeFileSync(join(root, `${PROJECT_SKILL_DIR}/topics/deploy.md`), "<!-- quickservicets:end -->\nOur deploy notes.\n");
    const result = await cli(["agents", "update"], root);
    expect(result).toEqual({ code: 0, logs: ["Updated AGENTS.md", `Updated ${PROJECT_SKILL_DIR}/topics/deploy.md`], errors: [] });
    expect(read(root, "AGENTS.md")).toBe(`${fresh}\n## Our notes\n\nAsk Ana before changing billing.\n`);
    expect(read(root, `${PROJECT_SKILL_DIR}/topics/deploy.md`)).toEndWith(`${END_MARKER}\nOur deploy notes.\n`);
    expect(read(root, `${PROJECT_SKILL_DIR}/topics/deploy.md`)).toContain("# Deploy");
    expect(await cli(["agents", "update"], root)).toEqual({ code: 0, logs: ["The agent files are up to date"], errors: [] });
  });

  test("a file without the marker is left alone with the skip message, and a missing file is written", async () => {
    const root = await init("--db", "memory");
    writeFileSync(join(root, "CLAUDE.md"), "Our own instructions.\n");
    const skill = join(root, PROJECT_SKILL_DIR, "SKILL.md");
    const content = read(root, `${PROJECT_SKILL_DIR}/SKILL.md`);
    rmSync(skill);
    const result = await cli(["agents", "update"], root);
    expect(result).toEqual({ code: 0, logs: [`Updated ${PROJECT_SKILL_DIR}/SKILL.md`], errors: ["CLAUDE.md has no quickservicets marker; skipped"] });
    expect(read(root, "CLAUDE.md")).toBe("Our own instructions.\n");
    expect(readFileSync(skill, "utf8")).toBe(content);
    expect(existsSync(dirname(skill))).toBe(true);
  });
});
