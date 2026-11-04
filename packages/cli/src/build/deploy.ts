import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { defaultPlatform, DEPLOY_DISABLED, DEPLOY_TARGETS, isFunctionTarget, unknownTarget, type DeployOptions, type ResolvedConfig } from "@quickservicets/core";
import { BuildError } from "../errors.ts";

/** What the deploy step wrote: the target, its folder relative to the project, its size in bytes and its files. */
export interface DeployOutput {
  target: string;
  /** The output folder relative to the project, with a trailing slash, like `dist/server/`. */
  dir: string;
  size: number;
  files: string[];
  /** The five largest modules of the bundle. */
  modules: ModuleSize[];
}

/** The `deploy` native's options, or undefined while it is off. */
export function deployOptionsOf(config: ResolvedConfig): DeployOptions | undefined {
  return config.features.find((feature) => feature.key === "deploy")?.options as unknown as DeployOptions | undefined;
}

/**
 * The target a build writes: `--target`, then `QS_DEPLOY_TARGET` and the config (already applied to the options),
 * then `server`; undefined while the native is off, which writes no deployable output. Fails for an unknown value,
 * and for any target but `server` while the native is off.
 */
export function deployTargetOf(config: ResolvedConfig, flag: string | undefined): string | undefined {
  if (flag !== undefined && !(DEPLOY_TARGETS as readonly string[]).includes(flag)) throw new BuildError(unknownTarget(flag));
  const options = deployOptionsOf(config);
  const target = flag ?? options?.target ?? "server";
  if (!options && target !== "server") throw new BuildError(DEPLOY_DISABLED);
  return options ? target : undefined;
}

/** What the function-mode checks read from the build. */
export interface FunctionModeInputs {
  target: string;
  workers: number;
  /** The names of the project's jobs. */
  jobs: readonly string[];
  /** The names of the queues the database broker consumes. */
  queues: readonly string[];
  /** The `ws.ts` endpoint files. */
  sockets: readonly string[];
}

/**
 * On `lambda` and `azure-functions` the service runs one process per instance and starts no scheduler, consumer loop
 * or socket: one warning per thing the platform must drive instead, and a failure for each WebSocket route.
 */
export function functionModeWarnings({ target, workers, jobs, queues, sockets }: FunctionModeInputs): string[] {
  if (!isFunctionTarget(target)) return [];
  const socket = sockets[0];
  if (socket) throw new BuildError(`${socket} cannot run on ${target}; WebSockets need a server target`);
  return [
    ...(workers > 1 ? [`server.workers is ignored on ${target}`] : []),
    ...jobs.map((name) => `jobs/${name} runs only when the platform invokes it (see the deploy guide)`),
    ...queues.map((name) => `queues/${name} needs a platform trigger (an SQS or Service Bus trigger) to be consumed`),
  ];
}

/** A size in bytes as `512 B`, `12.3 KB` or `4.5 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Every file under a folder, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The output folder of a target, emptied. */
export function targetFolder(root: string, options: Pick<DeployOptions, "outDir"> | undefined, target: string): string {
  const dir = join(root, options?.outDir ?? "dist", target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One file read at runtime: its path inside the assets and its absolute source. */
export interface RuntimeAsset {
  name: string;
  source: string;
}

/** The files of a project path (a file or a folder), as assets named by their project-relative path. */
function assetsOf(root: string, path: string): RuntimeAsset[] {
  const source = join(root, path);
  if (!existsSync(source)) return [];
  if (!statSync(source).isDirectory()) return [{ name: path, source }];
  return filesUnder(source).map((file) => ({ name: `${path}/${file.split(sep).join("/")}`, source: join(source, file) }));
}

/**
 * The files a service reads at runtime: the `migrations/` folder, `.generated/openapi.json`, the build output of each
 * feature with a build step (`.generated/<key>/`), and the files features list in `assets`.
 */
export function runtimeAssets(root: string, config: ResolvedConfig): RuntimeAsset[] {
  const paths = [
    "migrations",
    ".generated/openapi.json",
    ...config.features.filter((feature) => feature.definition.build).map((feature) => `.generated/${feature.key}`),
    ...config.features.flatMap((feature) => feature.definition.assets ?? []),
  ];
  const seen = new Set<string>();
  return paths.flatMap((path) => assetsOf(root, path)).filter((asset) => !seen.has(asset.name) && Boolean(seen.add(asset.name)));
}

/** The size of each bundled module, largest first. */
export interface ModuleSize {
  path: string;
  bytes: number;
}

/** What bundling the service produced. */
interface Bundled {
  modules: ModuleSize[];
}

/** The package a module path belongs to, like `better-sqlite3` for `node_modules/better-sqlite3/build/x.node`. */
function packageOf(path: string): string {
  const parts = path.split(/[\\/]/);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) return path;
  const name = parts[index + 1] ?? path;
  return name.startsWith("@") ? `${name}/${parts[index + 2]}` : name;
}

/** The failure of a module that cannot be bundled for a target. */
export function unbundleable(module: string, target: string): string {
  return target === "binary"
    ? `${module} cannot be bundled for ${target}; binary targets cannot load external modules; use the server target`
    : `${module} cannot be bundled for ${target}; add it to deploy.external and ship it next to the bundle`;
}

/** Writes the bundle's entry: it points `assetPath` at the assets, then starts the generated server. */
function writeEntry(root: string, assets: readonly RuntimeAsset[], embed: boolean): string {
  const file = join(root, ".generated/deploy/entry.ts");
  mkdirSync(dirname(file), { recursive: true });
  // Embedded files are copies, so a migration the registry imports as a module is not also imported as a file.
  const staged = join(root, ".generated/deploy/assets");
  if (embed) {
    rmSync(staged, { recursive: true, force: true });
    for (const asset of assets) {
      mkdirSync(dirname(join(staged, asset.name)), { recursive: true });
      copyFileSync(asset.source, join(staged, asset.name));
    }
  }
  const lines = embed
    ? [
        'import { setEmbeddedAssets } from "@quickservicets/core";',
        ...assets.map((asset, index) => `import asset${index} from ${JSON.stringify(`./assets/${asset.name}`)} with { type: "file" };`),
        "",
        `setEmbeddedAssets({ ${assets.map((asset, index) => `${JSON.stringify(asset.name)}: asset${index}`).join(", ")} });`,
      ]
    : ['import { join } from "node:path";', 'import { setAssetsRoot } from "@quickservicets/core";', "", 'setAssetsRoot(join(import.meta.dir, "assets"));'];
  writeFileSync(file, ["// Generated by quickservicets build. Do not edit.", ...lines, 'await import("../server.ts");', ""].join("\n"));
  return file;
}

/**
 * Bundles the service's entry into `outdir/<naming>` for Bun, minified with a linked source map, leaving `external`
 * packages out; fails naming a module that cannot be bundled (one that does not resolve, or a native addon).
 */
async function bundle(entry: string, outdir: string, target: string, external: readonly string[], naming = "server.js"): Promise<Bundled> {
  const result = await Bun.build({ entrypoints: [entry], outdir, target: "bun", naming, minify: true, sourcemap: "linked", external: [...external], metafile: true, throw: false });
  if (!result.success) {
    const unresolved = result.logs.map((log) => /Could not resolve: "([^"]+)"/.exec(String(log))?.[1]).find((name) => name !== undefined);
    if (unresolved) throw new BuildError(unbundleable(unresolved, target));
    throw new BuildError(`Bundling failed:\n${result.logs.map((log) => String(log)).join("\n")}`);
  }
  const inputs = Object.entries(result.metafile?.inputs ?? {});
  const addon = inputs.find(([path]) => path.endsWith(".node"));
  if (addon) throw new BuildError(unbundleable(packageOf(addon[0]), target));
  const bytes = new Map<string, number>();
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const [path, input] of Object.entries((output as { inputs?: Record<string, { bytesInOutput: number }> }).inputs ?? {})) bytes.set(path, (bytes.get(path) ?? 0) + input.bytesInOutput);
  }
  return { modules: [...bytes].map(([path, size]) => ({ path, bytes: size })).sort((a, b) => b.bytes - a.bytes) };
}

/** Copies the assets into `<dir>/assets/`. */
function copyAssets(dir: string, assets: readonly RuntimeAsset[]): void {
  for (const asset of assets) {
    const target = join(dir, "assets", asset.name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.source, target);
  }
}

/** The file name of a binary for a platform: `<name>`, or `<name>.exe` on Windows. */
export const binaryName = (name: string, platform: string) => (platform.startsWith("windows") ? `${name}.exe` : name);

/** The name of the service: `deploy.name`, or the package name without its scope. */
export function serviceName(root: string, options: Pick<DeployOptions, "name"> | undefined): string {
  if (options?.name) return options.name;
  const file = join(root, "package.json");
  const name = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { name?: string }).name ?? "") : "";
  return name.replace(/^@[^/]+\//, "") || "service";
}

/**
 * Compiles the service into one executable for a platform with `bun build --compile`, embedding its assets, at
 * `<dir>/<file>`; resolves the bundled modules' sizes.
 */
export async function compileBinary(root: string, dir: string, file: string, platform: string, target: string, external: readonly string[], assets: readonly RuntimeAsset[]): Promise<Bundled> {
  if (external.length > 0) throw new BuildError(unbundleable(external[0]!, target));
  const entry = writeEntry(root, assets, true);
  // Bundling first checks every module and measures them; the compiled executable embeds the same graph.
  const scratch = mkdtempSync(join(tmpdir(), "qs-compile-"));
  try {
    const bundled = await bundle(entry, scratch, target, external);
    const compiled = Bun.spawnSync([process.execPath, "build", entry, "--compile", "--minify", `--target=bun-${platform}`, "--outfile", join(dir, file)], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (compiled.exitCode !== 0) throw new BuildError(`Compiling for ${platform} failed:\n${compiled.stderr.toString()}${compiled.stdout.toString()}`);
    return bundled;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What `writeDeployOutput` accepts besides the project, the config and the target. */
export interface DeployBuildOptions {
  /** Also writes `<outDir>/<target>/bundle-report.json` with every module's size. */
  analyze?: boolean;
}

/**
 * Writes the deployable output of a target into `<outDir>/<target>/`, replacing what the folder held: for `server`,
 * `server.js` (minified, with `server.js.map`) and the runtime assets in `assets/`; for `binary`, one executable for the
 * platform with the assets embedded.
 */
export async function writeDeployOutput(root: string, config: ResolvedConfig, target: string, build: DeployBuildOptions = {}): Promise<DeployOutput> {
  const options = deployOptionsOf(config);
  const dir = targetFolder(root, options, target);
  const assets = runtimeAssets(root, config);
  const external = options?.external ?? [];
  let bundled: Bundled;
  if (target === "binary") {
    const platform = options?.platform ?? defaultPlatform(target);
    bundled = await compileBinary(root, dir, binaryName(serviceName(root, options), platform), platform, target, external, assets);
  } else {
    bundled = await bundle(writeEntry(root, assets, false), dir, target, external);
    copyAssets(dir, assets);
  }
  const files = filesUnder(dir);
  const size = files.reduce((total, file) => total + statSync(join(dir, file)).size, 0);
  if (build.analyze) writeFileSync(join(dir, "bundle-report.json"), `${JSON.stringify({ target, size, modules: bundled.modules }, null, 2)}\n`);
  return { target, dir: `${relative(root, dir)}/`, size, files: build.analyze ? [...files, "bundle-report.json"].sort() : files, modules: bundled.modules.slice(0, 5) };
}

/** The lines naming the largest modules of a bundle. */
export function largestModuleLines(modules: readonly ModuleSize[]): string[] {
  return modules.length === 0 ? [] : ["Largest modules:", ...modules.slice(0, 5).map((module) => `  ${module.path} (${formatSize(module.bytes)})`)];
}

/** The line a build prints for its target: `Target server: dist/server/ (1.2 MB)`. */
export const targetLine = (output: Pick<DeployOutput, "target" | "dir" | "size">) => `Target ${output.target}: ${output.dir} (${formatSize(output.size)})`;

/** Reads a file of the output, for tests and later steps. */
export const readOutput = (root: string, output: DeployOutput, file: string) => readFileSync(join(root, output.dir, file), "utf8");
