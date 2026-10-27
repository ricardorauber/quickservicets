import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { writeProjectAgentFiles } from "../agents/project.ts";
import { BuildError } from "../errors.ts";
import { version } from "../version.ts";
import { TOOLCHAIN } from "./toolchain.ts";

export const DATABASES = ["postgres", "mongodb", "sqlite", "memory"] as const;
export type DatabaseChoice = (typeof DATABASES)[number];

/** The database `init` takes without asking when the CLI is not interactive: it needs nothing installed or running. */
export const DEFAULT_DATABASE: DatabaseChoice = "memory";

export type Prompt = (question: string, choices: readonly string[]) => Promise<string>;

/** Installs the dependencies of a workspace, resolving to whether it succeeded. */
export type Install = (workspaceRoot: string) => Promise<boolean>;

export interface InitOptions {
  db?: string;
  /** Writes `AGENTS.md`, `CLAUDE.md` and the Claude Code skill for coding agents (default true). */
  agents?: boolean;
  prompt?: Prompt;
  install?: Install;
}

const bunInstall: Install = async (workspaceRoot) => {
  try {
    const child = Bun.spawn(["bun", "install"], { cwd: workspaceRoot, stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
};

const FRAMEWORK_PACKAGES = ["@quickservicets/core", "@quickservicets/cli"];

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function workspaceGlobs(manifest: Record<string, unknown>): string[] {
  const workspaces = manifest.workspaces;
  const globs = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(globs) ? globs.filter((glob): glob is string => typeof glob === "string") : [];
}

/**
 * The root of the QuickService.ts monorepo the target folder belongs to: a parent whose `workspaces` match the
 * folder and include both framework packages. Undefined anywhere else.
 */
export function quickservicetsWorkspace(target: string): string | undefined {
  for (let dir = dirname(resolve(target)); ; dir = dirname(dir)) {
    const manifest = readJson(join(dir, "package.json"));
    const globs = manifest ? workspaceGlobs(manifest) : [];
    if (globs.length > 0) {
      const path = relative(dir, resolve(target)).split(sep).join("/");
      const names = globs.flatMap((glob) =>
        [...new Bun.Glob(`${glob.replace(/\/+$/, "")}/package.json`).scanSync({ cwd: dir, onlyFiles: true })].map(
          (file) => readJson(join(dir, file))?.name,
        ),
      );
      const matches = globs.some((glob) => new Bun.Glob(glob.replace(/\/+$/, "")).match(path));
      if (matches && FRAMEWORK_PACKAGES.every((name) => names.includes(name))) return dir;
      return undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const CONFIGS: Record<DatabaseChoice, string> = {
  postgres: `import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  // security is on by default with safe defaults (headers, CORS, limits, rate limits); turn it off with security: false.
  // Other native features are one key each, like:
  // events: {},
  // history: {}, // needs events
});
`,
  mongodb: `import { defineConfig, mongodbAdapter } from "@quickservicets/core";

export default defineConfig({
  database: mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! }),
  // security is on by default with safe defaults (headers, CORS, limits, rate limits); turn it off with security: false.
  // Other native features are one key each, like:
  // events: {},
  // history: {}, // needs events
});
`,
  sqlite: `import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  // security is on by default with safe defaults (headers, CORS, limits, rate limits); turn it off with security: false.
  // Other native features are one key each, like:
  // events: {},
  // history: {}, // needs events
});
`,
  memory: `import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  // security is on by default with safe defaults (headers, CORS, limits, rate limits); turn it off with security: false.
  // Other native features are one key each, like:
  // events: {},
  // history: {}, // needs events
});
`,
};

const ENV: Record<DatabaseChoice, string> = {
  postgres: "DATABASE_URL=postgres://user:password@localhost:5432/app\n",
  mongodb: "DATABASE_URL=mongodb://localhost:27017\nDATABASE_NAME=app\n",
  sqlite: "DATABASE_PATH=data.db\n",
  memory: "",
};

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["bun"],
    },
    // TypeScript skips folders starting with a dot unless a pattern names their files.
    include: [
      "quickservicets.config.ts",
      "entities",
      "endpoints",
      "hooks",
      "jobs",
      "features",
      "migrations",
      "lib",
      "tests",
      ".generated/**/*.ts",
    ],
  },
  null,
  2,
)}\n`;

function packageJson(name: string, dependency: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "quickservicets dev",
        build: "quickservicets build",
        migrate: "quickservicets migrate",
        start: "bun .generated/server.ts",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "@quickservicets/core": dependency,
        "@quickservicets/cli": dependency,
      },
      devDependencies: { ...TOOLCHAIN },
    },
    null,
    2,
  )}\n`;
}

/** Asks on stdin, accepting a choice by number or by name. */
export const terminalPrompt: Prompt = async (question, choices) => {
  console.log(question);
  choices.forEach((choice, index) => console.log(`  ${index + 1}) ${choice}`));
  for await (const line of console) {
    const answer = line.trim();
    const byNumber = choices[Number(answer) - 1];
    if (byNumber) return byNumber;
    if (choices.includes(answer)) return answer;
    console.log(`Choose 1-${choices.length} or a name.`);
  }
  throw new BuildError("No database chosen");
};

/** Keeps secrets, dependencies and everything the framework generates out of git. */
const GITIGNORE = [".env", "node_modules/", ".generated/", "uploads/", "data.db"].join("\n") + "\n";

export const NEXT_STEPS = [
  "Next steps:",
  "  1. Install dependencies: bun install",
  "  2. Create an entity, e.g. entities/User.ts: export type User = { email: string }",
  "  3. Start the dev server: bun run dev",
];

/** `quickservicets init [dir] [--db <database>]` */
export async function initProject(directory: string, options: InitOptions = {}): Promise<string[]> {
  const root = resolve(directory);
  if (existsSync(root) && readdirSync(root).length > 0) throw new BuildError("Directory is not empty");
  if (options.db !== undefined && !(DATABASES as readonly string[]).includes(options.db)) {
    throw new BuildError(`Unknown database "${options.db}" (use ${DATABASES.join(", ")})`);
  }
  const db = (options.db ?? (await (options.prompt ?? terminalPrompt)("Which database?", DATABASES))) as DatabaseChoice;
  const workspace = quickservicetsWorkspace(root);

  const files: Record<string, string> = {
    "quickservicets.config.ts": CONFIGS[db],
    ".env": ENV[db],
    ".gitignore": GITIGNORE,
    "entities/.gitkeep": "",
    "endpoints/.gitkeep": "",
    "hooks/.gitkeep": "",
    "tsconfig.json": TSCONFIG,
    "package.json": packageJson(basename(root), workspace ? "workspace:*" : `^${version}`),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (options.agents !== false) writeProjectAgentFiles(root);
  if (!workspace) return NEXT_STEPS;
  const installed = await (options.install ?? bunInstall)(workspace);
  if (!installed) return [`Could not install dependencies; run "bun install" in ${workspace}`, ...NEXT_STEPS];
  return ["Next steps:", ...NEXT_STEPS.slice(2).map((step, index) => step.replace(/^ {2}\d+\./, `  ${index + 1}.`))];
}
