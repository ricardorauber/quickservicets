import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEPLOY_DISABLED, DEPLOY_TARGETS, isFunctionTarget, unknownTarget, type DeployOptions, type ResolvedConfig } from "@quickservicets/core";
import { BuildError } from "../errors.ts";

/** What the deploy step wrote: the target, its folder relative to the project, its size in bytes and its files. */
export interface DeployOutput {
  target: string;
  /** The output folder relative to the project, with a trailing slash, like `dist/server/`. */
  dir: string;
  size: number;
  files: string[];
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

/** Bundles the generated server entry into one JavaScript file for Bun. */
export async function bundleServer(root: string, outdir: string, naming = "server.js"): Promise<void> {
  const result = await Bun.build({ entrypoints: [join(root, ".generated/server.ts")], outdir, target: "bun", naming, throw: false });
  if (!result.success) throw new BuildError(`Bundling failed:\n${result.logs.map((log) => String(log)).join("\n")}`);
}

/**
 * Writes the deployable output of a target into `<outDir>/<target>/`, replacing what the folder held: the generated
 * server bundled into one file, which every target starts from.
 */
export async function writeDeployOutput(root: string, config: ResolvedConfig, target: string): Promise<DeployOutput> {
  const options = deployOptionsOf(config);
  const dir = targetFolder(root, options, target);
  await bundleServer(root, dir);
  const files = filesUnder(dir);
  const size = files.reduce((total, file) => total + statSync(join(dir, file)).size, 0);
  return { target, dir: `${relative(root, dir)}/`, size, files };
}

/** The line a build prints for its target: `Target server: dist/server/ (1.2 MB)`. */
export const targetLine = (output: Pick<DeployOutput, "target" | "dir" | "size">) => `Target ${output.target}: ${output.dir} (${formatSize(output.size)})`;

/** Reads a file of the output, for tests and later steps. */
export const readOutput = (root: string, output: DeployOutput, file: string) => readFileSync(join(root, output.dir, file), "utf8");
