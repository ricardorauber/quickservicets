/**
 * The minimal examples check: every native feature ships `examples/minimal/<key>`, a workspace whose README shows each
 * customization level and whose tests run the project end to end with `startTestService`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The second-level headings every minimal example's README has, in this order. */
export const LEVEL_HEADINGS = [
  "Level 0: enable",
  "Level 1: options and environment",
  "Level 2: tags",
  "Level 3: per request",
  "Level 4: hooks and events",
  "Level 5: override files",
  "Level 6: replace the implementation",
  "Level 7: eject",
] as const;

/** What the check needs of a native. */
export interface ExampleNative {
  key: string;
  enabledByDefault: boolean;
}

const WORKSPACE_DEPENDENCIES = { "@quickservice/core": "workspace:*", "@quickservice/cli": "workspace:*" };

/** The test files of a folder, subfolders included, without `node_modules`. */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts") && !join(entry.parentPath, entry.name).includes("node_modules"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The problems of a README: missing or misplaced level headings, and level sections without a sample or a reason. */
export function readmeProblems(readme: string): string[] {
  const lines = readme.split("\n");
  const headings = lines.map((line, index) => ({ text: /^## (.+?)\s*$/.exec(line)?.[1], index })).filter((heading): heading is { text: string; index: number } => heading.text !== undefined);
  const problems: string[] = [];
  let previous = -1;
  for (const required of LEVEL_HEADINGS) {
    const position = headings.findIndex((heading) => heading.text === required);
    if (position < 0) {
      problems.push(`missing README heading ${required}`);
      continue;
    }
    if (position < previous) problems.push(`README heading ${required} is out of order`);
    previous = Math.max(previous, position);
    const start = headings[position]!.index + 1;
    const end = headings[position + 1]?.index ?? lines.length;
    const section = lines.slice(start, end);
    const hasSample = section.some((line) => /^\s*```/.test(line));
    const hasReason = section.some((line) => /^Not applicable: \S/.test(line.trim()));
    if (!hasSample && !hasReason) problems.push(`README section ${required} has no code sample or Not applicable: line`);
  }
  return problems;
}

/** The problems of one native's example folder. */
function exampleProblems(dir: string, native: ExampleNative): string[] {
  if (!existsSync(dir)) return ["missing folder"];
  const problems: string[] = [];
  const packageFile = join(dir, "package.json");
  if (!existsSync(packageFile)) problems.push("missing package.json");
  else {
    const dependencies = (JSON.parse(readFileSync(packageFile, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
    if (Object.entries(WORKSPACE_DEPENDENCIES).some(([name, version]) => dependencies[name] !== version)) {
      problems.push("package.json must depend on @quickservice/core and @quickservice/cli with workspace:*");
    }
  }
  const configFile = join(dir, "quickservice.config.ts");
  if (!existsSync(configFile)) problems.push("missing quickservice.config.ts");
  else if (!native.enabledByDefault && !new RegExp(`(^|[\\s{,])["']?${native.key}["']?\\s*:`, "m").test(readFileSync(configFile, "utf8"))) {
    problems.push(`quickservice.config.ts does not enable ${native.key}`);
  }
  const readmeFile = join(dir, "README.md");
  if (!existsSync(readmeFile)) problems.push("missing README.md");
  else problems.push(...readmeProblems(readFileSync(readmeFile, "utf8")));
  const tests = testFiles(dir);
  if (tests.length === 0) problems.push("missing a *.test.ts file");
  else if (!tests.some((file) => readFileSync(file, "utf8").includes("startTestService"))) problems.push("tests must start the project with startTestService");
  return problems;
}

/**
 * Every problem of the minimal examples under `root`, one line each as `examples/minimal/<folder>: <problem>`: a missing
 * or incomplete example of a native, and a folder named after neither a native key nor `plugin-<key>` of an existing
 * `packages/plugin-<key>` package.
 */
export function minimalExampleProblems(root: string, natives: readonly ExampleNative[]): string[] {
  const minimal = join(root, "examples/minimal");
  const problems: string[] = [];
  for (const native of natives) {
    for (const problem of exampleProblems(join(minimal, native.key), native)) problems.push(`examples/minimal/${native.key}: ${problem}`);
  }
  const keys = new Set(natives.map((native) => native.key));
  const folders = existsSync(minimal) ? readdirSync(minimal, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "node_modules") : [];
  for (const { name } of folders) {
    if (keys.has(name)) continue;
    const plugin = /^plugin-(.+)$/.exec(name)?.[1];
    if (plugin && existsSync(join(root, "packages", `plugin-${plugin}`))) continue;
    problems.push(`examples/minimal/${name}: unknown folder; minimal examples are named after a native key, or plugin-<key> for a packages/plugin-<key> package`);
  }
  return problems;
}
