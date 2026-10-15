import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BuildError } from "../errors.ts";
import { version } from "../version.ts";

export const DATABASES = ["postgres", "mongodb", "sqlite", "memory"] as const;
export type DatabaseChoice = (typeof DATABASES)[number];

export type Prompt = (question: string, choices: readonly string[]) => Promise<string>;

export interface InitOptions {
  db?: string;
  prompt?: Prompt;
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
    include: ["quickservice.config.ts", "entities", "endpoints", "hooks", ".generated"],
  },
  null,
  2,
)}\n`;

function packageJson(name: string): string {
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
        "@quickservice/core": `^${version}`,
        "@quickservice/cli": `^${version}`,
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

  const files: Record<string, string> = {
    "quickservice.config.ts": CONFIGS[db],
    ".env": ENV[db],
    ".gitignore": ".env\nnode_modules\n",
    "entities/.gitkeep": "",
    "endpoints/.gitkeep": "",
    "hooks/.gitkeep": "",
    "tsconfig.json": TSCONFIG,
    "package.json": packageJson(basename(root)),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return NEXT_STEPS;
}
