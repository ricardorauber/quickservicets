import type { AgentTopic } from "./topics.ts";

/** The name of the Claude Code skill. */
export const SKILL_NAME = "quickservicets";

/** The longest skill description Claude Code accepts. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** The most lines the skill's body may have. */
export const MAX_SKILL_BODY_LINES = 200;

/** What the skill's description says, naming when Claude Code should load it. */
export const SKILL_DESCRIPTION =
  "Builds and changes backends with QuickService.ts, the Bun framework that turns TypeScript entity types into REST services with CRUD routes, validation, migrations and OpenAPI docs. Use it to build a backend, API or service with QuickService.ts; to add an entity, endpoint, hook, job or feature to a QuickService.ts project; or whenever you work in a project with a quickservicets.config.ts.";

/** The rules every agent follows in a QuickService.ts project. */
export const SKILL_RULES = [
  "Never edit `.generated/`; `quickservicets build` rewrites it from the sources.",
  "Use the CLI for migrations: `bun run quickservicets migration add <Name>` then `bun run quickservicets migrate`; never write migration files or SQL by hand, and never edit an applied migration.",
  "Run `bun run build` (`quickservicets build`) after changing entities, endpoints, hooks, jobs, features or the config, then `bun run typecheck`.",
  "Pass `--db` to `quickservicets init`, so it never waits for an answer.",
  "Read records with `.toArray()`; `any`, `all` and `none` answer `true` or `false`.",
  "Test with `startTestService` from `@quickservicets/cli/testing` and `bun test`, not against a running server.",
];

/** The workflow steps of the skill, from an empty folder to a running service. */
export const SKILL_WORKFLOW = [
  "Create the project in any folder, then install: `bunx quickservicets init <name> --db sqlite` (or `memory`, `postgres`, `mongodb`), `cd <name>`, `bun install`.",
  "Add one entity per file in `entities/`, PascalCase, exporting a type with the same name, like `entities/Task.ts` exporting `Task`; tags such as `@unique` and `@default` go in JSDoc comments.",
  "Build: `bun run build` writes `.generated/` (routes, types, OpenAPI document, server entry).",
  "On SQLite, PostgreSQL or MongoDB, create and apply a migration for every model change: `bun run quickservicets migration add <Name>`, `bun run quickservicets migrate`.",
  "Run: `bun run dev` serves on port 3000 (`PORT` changes it) and rebuilds on every change; `Task` is served at `/tasks`.",
  "Add custom routes as files in `endpoints/` (`endpoints/tasks/[id]/complete/post.ts`), hooks in `hooks/` attached with tags, jobs in `jobs/`, and native features with one config key (`queues: {}`).",
];

/** The skill's `SKILL.md`: frontmatter with its name and description, then when to use it, the workflow, the rules and the topics. */
export function skillMarkdown(topics: readonly AgentTopic[]): string {
  const overview = topics.find((topic) => topic.name === "overview");
  const section = (heading: string) => {
    const lines = overview?.markdown.split("\n") ?? [];
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0) return [];
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.startsWith("- "));
  };
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    "---",
    "",
    "# QuickService.ts",
    "",
    "QuickService.ts builds REST services on Bun from TypeScript types: each entity type in `entities/` becomes CRUD routes, validation, filters, relations, migrations, typed repositories and an OpenAPI document. Packages: `@quickservicets/core`, `@quickservicets/cli` and `quickservicets` (for `bunx quickservicets`).",
    "",
    "## When to use it",
    "",
    ...section("Use it when"),
    "",
    "Pick something else when:",
    "",
    ...section("Do not use it when"),
    "",
    "## Workflow",
    "",
    ...SKILL_WORKFLOW.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Rules",
    "",
    ...SKILL_RULES.map((rule) => `- ${rule}`),
    "",
    "## Topics",
    "",
    "Read the topic that matches the task before writing code:",
    "",
    ...topics.map((topic) => `- \`topics/${topic.name}.md\`: ${topic.summary}`),
    "",
  ].join("\n");
}

/** What breaks the skill's format: a missing name or description, a description too long, or a body too long. */
export function skillProblems(markdown: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) return ["SKILL.md has no frontmatter"];
  const fields = Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
  const problems: string[] = [];
  if (!fields.name) problems.push("the frontmatter has no name");
  if (!fields.description) problems.push("the frontmatter has no description");
  else if (fields.description.length > MAX_DESCRIPTION_LENGTH) problems.push(`the description has ${fields.description.length} characters, more than ${MAX_DESCRIPTION_LENGTH}`);
  const body = markdown.slice(match[0].length).replace(/\n$/, "").split("\n");
  if (body.length >= MAX_SKILL_BODY_LINES) problems.push(`the body has ${body.length} lines, ${MAX_SKILL_BODY_LINES} or more`);
  return problems;
}
