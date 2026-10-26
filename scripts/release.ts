/**
 * Packs and publishes the public packages.
 *
 * `bun run release:check` packs each public package with `bun pm pack` into a temporary folder, checks every tarball
 * (no test file, no `.env` file, no path outside the package, no `workspace:` dependency; `LICENSE`, `README.md` and
 * the `bin` targets present), installs the three tarballs into an empty temporary folder and runs
 * `quickservicets init demo --db memory` and `bun run build` there.
 *
 * `bun run release` runs the same check, then publishes the checked tarballs in dependency order with
 * `npm publish <tarball> --access public` (plus `--otp $NPM_OTP` when it is set), stopping at the first failure.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";

const root = join(import.meta.dir, "..");

/** The public packages, in the order they are published: each depends only on the ones before it. */
export const PUBLIC_PACKAGES = ["packages/core", "packages/cli", "packages/quickservicets"];

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export interface Manifest {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** A packed package: its tarball, the manifest inside it and the paths of its entries. */
export interface PackedPackage {
  dir: string;
  tarball: string;
  manifest: Manifest;
  entries: string[];
}

/** Runs a command and returns its exit code and output. */
export type Runner = (command: string[], options?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<{ code: number; output: string }>;

export const spawnRunner: Runner = async (command, options = {}) => {
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env ?? process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}`.trim() };
};

/**
 * Runs a command attached to the terminal, so npm can show its browser link for passkey (web) authentication and read
 * prompts; the output is not captured.
 */
export const interactiveRunner: Runner = async (command, options = {}) => {
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env ?? process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return { code: await child.exited, output: "" };
};

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|\.snap|(^|[-.])test-support\.[cm]?[jt]sx?)$/;
const TEST_FOLDER = /(^|\/)(__tests__|__snapshots__)\//;

/** The bin targets of a manifest, as paths relative to the package. */
function binTargets(manifest: Manifest): string[] {
  if (manifest.bin === undefined) return [];
  return typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin);
}

/**
 * What is wrong with a packed package: a test file, a `.env` file, a path outside the package or a `workspace:`
 * dependency, or a missing `LICENSE`, `README.md` or `bin` target. Each problem names the file or dependency.
 */
export function tarballProblems(entries: readonly string[], manifest: Manifest): string[] {
  const problems: string[] = [];
  const inside = new Set<string>();
  for (const entry of entries) {
    const segments = entry.split("/");
    if (!entry.startsWith("package/") || entry.startsWith("/") || segments.includes("..")) {
      problems.push(`path outside the package: ${entry}`);
      continue;
    }
    const path = entry.slice("package/".length);
    inside.add(path);
    const name = basename(path);
    if (TEST_FILE.test(name) || TEST_FOLDER.test(path)) problems.push(`test file: ${path}`);
    if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) problems.push(`.env file: ${path}`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) problems.push(`workspace dependency: ${name}@${range} in ${field}`);
    }
  }
  for (const required of ["LICENSE", "README.md"]) if (!inside.has(required)) problems.push(`missing ${required}`);
  for (const target of binTargets(manifest)) {
    const path = posix.normalize(target).replace(/^\.\//, "");
    if (!inside.has(path)) problems.push(`missing bin target: ${target}`);
  }
  return problems;
}

/** The manifest with every `workspace:` dependency replaced by the exact version of that package. */
export function pinWorkspaceVersions(manifest: Manifest, versions: ReadonlyMap<string, string>): Manifest {
  const pinned: Manifest = { ...manifest };
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    pinned[field] = Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (!range.startsWith("workspace:")) return [name, range];
        const version = versions.get(name);
        if (!version) throw new Error(`${manifest.name}: no workspace package ${name} to pin ${range} to`);
        return [name, version];
      }),
    );
  }
  return pinned;
}

async function tar(args: string[], run: Runner): Promise<string> {
  const result = await run(["tar", ...args]);
  if (result.code !== 0) throw new Error(`tar ${args.join(" ")} failed: ${result.output}`);
  return result.output;
}

/** Reads a tarball's entries and manifest. */
export async function readTarball(tarball: string, run: Runner = spawnRunner): Promise<{ entries: string[]; manifest: Manifest }> {
  const entries = (await tar(["-tzf", tarball], run))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith("/"));
  const manifest = JSON.parse(await tar(["-xzOf", tarball, "package/package.json"], run)) as Manifest;
  return { entries, manifest };
}

/** Rewrites the manifest inside a tarball when pinning its `workspace:` dependencies changes it. */
async function pinTarball(tarball: string, manifest: Manifest, versions: ReadonlyMap<string, string>, run: Runner): Promise<Manifest> {
  const pinned = pinWorkspaceVersions(manifest, versions);
  if (JSON.stringify(pinned) === JSON.stringify(manifest)) return manifest;
  const work = mkdtempSync(join(tmpdir(), "quickservicets-pin-"));
  try {
    await tar(["-xzf", tarball, "-C", work], run);
    writeFileSync(join(work, "package/package.json"), `${JSON.stringify(pinned, null, 2)}\n`);
    await tar(["-czf", tarball, "-C", work, "package"], run);
    return pinned;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Packs every public package into `destination`, with `workspace:` dependencies pinned to exact versions. */
export async function packAll(destination: string, packages: readonly string[] = PUBLIC_PACKAGES, run: Runner = spawnRunner): Promise<PackedPackage[]> {
  mkdirSync(destination, { recursive: true });
  const versions = new Map(
    packages.map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
      return [manifest.name, manifest.version] as const;
    }),
  );
  const packed: PackedPackage[] = [];
  for (const dir of packages) {
    const result = await run(["bun", "pm", "pack", "--destination", destination, "--quiet"], { cwd: join(root, dir) });
    if (result.code !== 0) throw new Error(`bun pm pack failed in ${dir}: ${result.output}`);
    const tarball = result.output.split("\n").filter(Boolean).at(-1)!.trim();
    const read = await readTarball(tarball, run);
    const manifest = await pinTarball(tarball, read.manifest, versions, run);
    packed.push({ dir, tarball, manifest, entries: read.entries });
  }
  return packed;
}

export interface CheckResult {
  ok: boolean;
  packed: PackedPackage[];
  /** One line per problem, prefixed with the package name. */
  problems: string[];
}

/** Installs the tarballs into an empty folder, then runs `quickservicets init demo --db memory` and `bun run build`. */
async function tryInstall(packed: readonly PackedPackage[], run: Runner): Promise<string[]> {
  const folder = mkdtempSync(join(tmpdir(), "quickservicets-release-"));
  try {
    const files = Object.fromEntries(packed.map((entry) => [entry.manifest.name, `file:${entry.tarball}`]));
    writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "release-check", private: true, dependencies: files, overrides: files }, null, 2)}\n`);
    const steps: [string, string[], string][] = [
      ["bun install", ["bun", "install"], folder],
      ["quickservicets init demo --db memory", [join(folder, "node_modules/.bin/quickservicets"), "init", "demo", "--db", "memory"], folder],
      ["bun run build", ["bun", "run", "build"], join(folder, "demo")],
    ];
    for (const [label, command, cwd] of steps) {
      const result = await run(command, { cwd });
      if (result.code !== 0) return [`${label} failed in ${cwd}:\n${result.output}`];
    }
    return [];
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** `bun run release:check`: packs, checks every tarball, then installs them and builds a new project. */
export async function releaseCheck(destination: string, options: { packages?: readonly string[]; run?: Runner } = {}): Promise<CheckResult> {
  const run = options.run ?? spawnRunner;
  const packed = await packAll(destination, options.packages, run);
  const problems = packed.flatMap((entry) => tarballProblems(entry.entries, entry.manifest).map((problem) => `${entry.manifest.name}: ${problem}`));
  if (problems.length === 0) problems.push(...(await tryInstall(packed, run)));
  return { ok: problems.length === 0, packed, problems };
}

/**
 * Publishes the tarballs in order with `npm publish <tarball> --access public` (and `--otp` when given), stopping at
 * the first failure. npm runs attached to the terminal by default, so accounts with a passkey confirm each publish in the
 * browser. Returns the names published and, on a failure, the package that failed.
 */
export async function publishAll(
  packed: readonly PackedPackage[],
  options: { otp?: string; run?: Runner; log?: (line: string) => void } = {},
): Promise<{ published: string[]; failed?: string; output?: string }> {
  const run = options.run ?? interactiveRunner;
  const published: string[] = [];
  for (const entry of packed) {
    const command = ["npm", "publish", entry.tarball, "--access", "public", ...(options.otp ? ["--otp", options.otp] : [])];
    const result = await run(command);
    if (result.code !== 0) return { published, failed: entry.manifest.name, output: result.output };
    published.push(entry.manifest.name);
    options.log?.(`Published ${entry.manifest.name}@${entry.manifest.version}`);
  }
  return { published };
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "check" && mode !== "publish") {
    console.error("Usage: bun scripts/release.ts check|publish");
    process.exit(1);
  }
  const destination = mkdtempSync(join(tmpdir(), "quickservicets-pack-"));
  const check = await releaseCheck(destination);
  for (const entry of check.packed) console.log(`Packed ${entry.manifest.name}@${entry.manifest.version}: ${entry.tarball}`);
  if (!check.ok) {
    for (const problem of check.problems) console.error(problem);
    console.error("release:check failed");
    process.exit(1);
  }
  console.log("release:check passed");
  if (mode === "check") process.exit(0);
  const result = await publishAll(check.packed, { otp: process.env.NPM_OTP || undefined, log: (line) => console.log(line) });
  if (result.failed) {
    const rest = check.packed.map((entry) => entry.manifest.name).filter((name) => name !== result.failed && !result.published.includes(name));
    console.error(`npm publish failed for ${result.failed}${result.output ? `:\n${result.output}` : " (see npm's output above)"}`);
    console.error(`Not published: ${[result.failed, ...rest].join(", ")}`);
    process.exit(1);
  }
}
