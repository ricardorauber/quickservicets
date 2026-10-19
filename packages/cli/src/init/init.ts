import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { BuildError } from "../errors.ts";
import { version } from "../version.ts";

export const DATABASES = ["postgres", "mongodb", "sqlite", "memory"] as const;
export type DatabaseChoice = (typeof DATABASES)[number];

export type Prompt = (question: string, choices: readonly string[]) => Promise<string>;

/** Installs the dependencies of a workspace, resolving to whether it succeeded. */
export type Install = (workspaceRoot: string) => Promise<boolean>;

export interface InitOptions {
  db?: string;
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

const FRAMEWORK_PACKAGES = ["@quickservice/core", "@quickservice/cli"];

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
 * The root of the QuickService monorepo the target folder belongs to: a parent whose `workspaces` match the
 * folder and include both framework packages. Undefined anywhere else.
 */
export function quickserviceWorkspace(target: string): string | undefined {
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
  postgres: `import { defineConfig, postgresAdapter } from "@quickservice/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
});
`,
  mongodb: `import { defineConfig, mongodbAdapter } from "@quickservice/core";

export default defineConfig({
  database: mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! }),
});
`,
  sqlite: `import { defineConfig, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
});
`,
  memory: `import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
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
    },
    // TypeScript skips folders starting with a dot unless a pattern names their files.
    include: ["quickservice.config.ts", "entities", "endpoints", "hooks", ".generated/**/*.ts"],
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
        dev: "quickservice dev",
        build: "quickservice build",
        migrate: "quickservice migrate",
        start: "bun .generated/server.ts",
      },
      dependencies: {
        "@quickservice/core": dependency,
        "@quickservice/cli": dependency,
      },
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

export const NEXT_STEPS = [
  "Next steps:",
  "  1. Install dependencies: bun install",
  "  2. Create an entity, e.g. entities/User.ts: export type User = { email: string }",
  "  3. Start the dev server: bun run dev",
];

/** `quickservice init [dir] [--db <database>]` */
export async function initProject(directory: string, options: InitOptions = {}): Promise<string[]> {
  const root = resolve(directory);
  if (existsSync(root) && readdirSync(root).length > 0) throw new BuildError("Directory is not empty");
  if (options.db !== undefined && !(DATABASES as readonly string[]).includes(options.db)) {
    throw new BuildError(`Unknown database "${options.db}" (use ${DATABASES.join(", ")})`);
  }
  const db = (options.db ?? (await (options.prompt ?? terminalPrompt)("Which database?", DATABASES))) as DatabaseChoice;
  const workspace = quickserviceWorkspace(root);

  const files: Record<string, string> = {
    "quickservice.config.ts": CONFIGS[db],
    ".env": ENV[db],
    ".gitignore": ".env\nnode_modules\n",
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
  if (!workspace) return NEXT_STEPS;
  const installed = await (options.install ?? bunInstall)(workspace);
  if (!installed) return [`Could not install dependencies; run "bun install" in ${workspace}`, ...NEXT_STEPS];
  return ["Next steps:", ...NEXT_STEPS.slice(2).map((step, index) => step.replace(/^ {2}\d+\./, `  ${index + 1}.`))];
}
