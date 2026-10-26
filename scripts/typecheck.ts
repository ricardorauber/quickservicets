/**
 * Type-checks every TypeScript project of the repository with its own tsconfig: `bun run typecheck`.
 * Projects with a `quickservicets.config.ts` are built first, because their code imports what the build generates.
 * Also reports `unsafe()` calls that receive built SQL text (see `unsafe-sql.ts`).
 * Prints the compiler output of each failing project and every SQL problem, and exits non-zero when there is any.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { checkUnsafeSql, formatProblem } from "./unsafe-sql.ts";

const root = join(import.meta.dir, "..");
const tsc = Bun.resolveSync("typescript/bin/tsc", root);

/** The directory of every project to check, relative to the repository root. */
export function projects(): string[] {
  const workspaces = (folder: string) =>
    existsSync(join(root, folder))
      ? readdirSync(join(root, folder), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(root, folder, entry.name, "package.json")))
          .map((entry) => `${folder}/${entry.name}`)
      : [];
  const examples = [...workspaces("examples"), ...workspaces("examples/minimal")].sort();
  return ["packages/core", "packages/cli", "docs/scripts", "docs/tests", "benchmarks/quickservicets", ...examples];
}

async function run(command: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

/** Checks one project; the output is empty when it has no errors. */
async function check(project: string): Promise<{ project: string; ok: boolean; output: string }> {
  const dir = join(root, project);
  if (!existsSync(join(dir, "tsconfig.json"))) return { project, ok: false, output: `${project}: missing tsconfig.json` };
  if (existsSync(join(dir, "quickservicets.config.ts"))) {
    const built = await run(["bun", "run", "quickservicets", "build"], dir);
    if (!built.ok) return { project, ok: false, output: `${project}: quickservicets build failed\n${built.output}` };
  }
  // Paths in the compiler output are relative to the repository root, so they name the file wherever the error is.
  const checked = await run(["bun", tsc, "--noEmit", "--pretty", "false", "-p", relative(root, dir)], root);
  return { project, ok: checked.ok, output: checked.output };
}

if (import.meta.main) {
  const results = await Promise.all(projects().map(check));
  for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.project}`);
    if (!result.ok) console.log(result.output);
  }
  const problems = checkUnsafeSql(root);
  console.log(`${problems.length === 0 ? "ok  " : "FAIL"} unsafe() calls`);
  for (const problem of problems) console.log(formatProblem(problem));
  process.exit(results.every((result) => result.ok) && problems.length === 0 ? 0 : 1);
}
