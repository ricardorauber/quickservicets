import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { defaultPlatform, parseDuration, DEPLOY_DISABLED, DEPLOY_TARGETS, isFunctionTarget, unknownTarget, type DeployOptions, type ResolvedConfig } from "@quickservicets/core";
import { BuildError } from "../errors.ts";
import { zipArchive } from "./zip.ts";
import { hostDuration, ncrontab, timerFunctionName } from "./azure.ts";

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
  /** The `sse.ts` endpoint files. */
  streams?: readonly string[];
  /** Whether `deploy.lambda.streaming` is on. */
  lambdaStreaming?: boolean;
}

/**
 * On `lambda` and `azure-functions` the service runs one process per instance and starts no scheduler, consumer loop
 * or socket: one warning per thing the platform must drive instead, and a failure for each WebSocket route.
 */
export function functionModeWarnings({ target, workers, jobs, queues, sockets, streams = [], lambdaStreaming = false }: FunctionModeInputs): string[] {
  if (!isFunctionTarget(target)) return [];
  const socket = sockets[0];
  if (socket) throw new BuildError(`${socket} cannot run on ${target}; WebSockets need a server target`);
  return [
    ...(workers > 1 ? [`server.workers is ignored on ${target}`] : []),
    ...jobs.map((name) => `jobs/${name} runs only when the platform invokes it (see the deploy guide)`),
    ...queues.map((name) => `queues/${name} needs a platform trigger (an SQS or Service Bus trigger) to be consumed`),
    ...(target === "lambda" && !lambdaStreaming && streams.length > 0 ? ["sse.ts routes need deploy.lambda.streaming: true on lambda"] : []),
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
  return target !== "server"
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
 * Writes the entry of a platform binary: the generated inputs of the service, its embedded assets, and one call of a
 * platform runner of the core, like `runLambda(inputs, options)`; `inputs` names the inputs in the call.
 */
function writePlatformEntry(root: string, assets: readonly RuntimeAsset[], call: string): string {
  const file = join(root, ".generated/deploy/platform-entry.ts");
  writeEntry(root, assets, true);
  const runner = /^(\w+)\(/.exec(call)![1]!;
  const config = existsSync(join(root, "quickservicets.config.ts")) ? 'import projectConfig from "../../quickservicets.config.ts";' : "const projectConfig: ServiceConfig = {};";
  const lines = [
    "// Generated by quickservicets build. Do not edit.",
    `import { assetPath, setEmbeddedAssets, ${runner}, type ServiceConfig } from "@quickservicets/core";`,
    config,
    'import { featureFolders, features } from "../features.ts";',
    'import { models } from "../models.ts";',
    'import { crudRoutes, endpoints, hooks } from "../routes.ts";',
    'import { jobs } from "../jobs.ts";',
    ...assets.map((asset, index) => `import asset${index} from ${JSON.stringify(`./assets/${asset.name}`)} with { type: "file" };`),
    "",
    `setEmbeddedAssets({ ${assets.map((asset, index) => `${JSON.stringify(asset.name)}: asset${index}`).join(", ")} });`,
    'const openApi = () => Bun.file(assetPath(".generated/openapi.json")).json();',
    'const inputs = { projectConfig, models, crudRoutes, endpoints, hooks, jobs, openApi, features, featureFolders, generatedDir: assetPath(".generated") };',
    `await ${call};`,
    "",
  ];
  writeFileSync(file, lines.join("\n"));
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
export async function compileBinary(root: string, dir: string, file: string, platform: string, target: string, external: readonly string[], assets: readonly RuntimeAsset[], platformCall?: string): Promise<Bundled> {
  if (external.length > 0) throw new BuildError(unbundleable(external[0]!, target));
  const entry = platformCall ? writePlatformEntry(root, assets, platformCall) : writeEntry(root, assets, true);
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
  /** The project's jobs with their schedules, for the targets that write a function per job. */
  jobs?: readonly { name: string; schedule: unknown }[];
  /** The paths of the project's routes, generated and custom, for the targets whose function names could collide. */
  routes?: readonly string[];
}

/** The files of the azure-functions target besides the binary, and the timer functions with their jobs. */
export function azureFunctionFiles(executable: string, options: NonNullable<DeployOptions["azure"]>, jobs: readonly { name: string; schedule: unknown }[], routes: readonly string[]): { files: Record<string, string>; timers: Record<string, string> } {
  const timers: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const job of jobs) {
    const schedule = ncrontab(job.schedule);
    if ("error" in schedule) throw new BuildError(`jobs/${job.name}: ${schedule.error}`);
    const name = timerFunctionName(job.name);
    timers[name] = job.name;
    files[`${name}/function.json`] = `${JSON.stringify({ bindings: [{ name: "timer", type: "timerTrigger", direction: "in", schedule: schedule.cron }] }, null, 2)}\n`;
  }
  for (const name of ["http", ...Object.keys(timers)]) {
    if (routes.includes(`/${name}`)) throw new BuildError(`Route /${name} collides with the Azure function ${name}; rename the route`);
  }
  files["http/function.json"] = `${JSON.stringify(
    {
      bindings: [
        { authLevel: options.authLevel, type: "httpTrigger", direction: "in", name: "req", methods: ["get", "post", "put", "patch", "delete", "head", "options"], route: "{*path}" },
        { type: "http", direction: "out", name: "res" },
      ],
    },
    null,
    2,
  )}\n`;
  files["host.json"] = `${JSON.stringify(
    {
      version: "2.0",
      customHandler: { description: { defaultExecutablePath: executable, workingDirectory: "", arguments: [] }, enableForwardingHttpRequest: true },
      extensions: { http: { routePrefix: "" } },
      ...(options.extensionBundle ? { extensionBundle: { id: "Microsoft.Azure.Functions.ExtensionBundle", version: "[4.*, 5.0.0)" } } : {}),
      ...(options.functionTimeout ? { functionTimeout: hostDuration(options.functionTimeout, parseDuration) } : {}),
    },
    null,
    2,
  )}\n`;
  return { files, timers };
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
  } else if (target === "lambda") {
    const lambda = options?.lambda ?? { architecture: "arm64", streaming: false };
    // The bootstrap runs on Amazon Linux; deploy.platform, when set, wins (a local platform runs it outside AWS).
    const platform = options?.platform ?? (lambda.architecture === "x86_64" ? "linux-x64" : "linux-arm64");
    bundled = await compileBinary(root, dir, "bootstrap", platform, target, external, assets, `runLambda(inputs, ${JSON.stringify({ streaming: lambda.streaming })})`);
    writeFileSync(join(dir, "function.zip"), zipArchive([{ name: "bootstrap", data: new Uint8Array(readFileSync(join(dir, "bootstrap"))), mode: 0o755 }]));
  } else if (target === "azure-functions") {
    const platform = options?.platform ?? defaultPlatform(target);
    const executable = binaryName(serviceName(root, options), platform);
    const { files, timers } = azureFunctionFiles(executable, options?.azure ?? { authLevel: "anonymous", extensionBundle: true }, build.jobs ?? [], build.routes ?? []);
    bundled = await compileBinary(root, dir, executable, platform, target, external, assets, `runAzureFunctions(inputs, ${JSON.stringify({ jobs: timers })})`);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
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
