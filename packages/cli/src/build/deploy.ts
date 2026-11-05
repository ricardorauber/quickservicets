import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { featureTargets, runAfterHooks, runBeforeHooks, type BundleInput, type FeatureHook, CLOUD_RUN_DRAIN_DELAY, CLOUD_RUN_STOP_TIMEOUT, cloudRunConfig, defaultPlatform, dockerfile, parseDuration, DEPLOY_DISABLED, DEPLOY_TARGETS, isFunctionTarget, triggerSources, unknownTarget, type DeployOptions, type ResolvedConfig, type TriggerSourceRef } from "@quickservicets/core";
import { BuildError } from "../errors.ts";
import { zipArchive } from "./zip.ts";
import { hostDuration, ncrontab, timerFunctionName, triggerFunctionName } from "./azure.ts";

/** What the deploy step wrote: the target, its folder relative to the project, its size in bytes and its files. */
export interface DeployOutput {
  target: string;
  /** The output folder relative to the project, with a trailing slash, like `dist/server/`. */
  dir: string;
  size: number;
  files: string[];
  /** The five largest modules of the bundle. */
  modules: ModuleSize[];
  /** `Override:` lines of the project files that replaced generated ones. */
  overrides: string[];
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
  const options = deployOptionsOf(config);
  const custom = [...Object.keys(options?.targets ?? {}), ...featureTargets().keys()];
  if (flag !== undefined && !(DEPLOY_TARGETS as readonly string[]).includes(flag) && !custom.includes(flag)) throw new BuildError(unknownTarget(flag));
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

/** The message of a stop budget over Cloud Run's grace period. */
export const CLOUD_RUN_STOP_WARNING = "Cloud Run stops containers 10 seconds after SIGTERM; lower lifecycle.stopTimeout or health.drainDelay";

/** The message of background work while the CPU is throttled outside requests. */
export const CLOUD_RUN_BACKGROUND_WARNING = "Background work needs deploy.cloudRun.cpuAlwaysAllocated: true on cloud-run";

/**
 * The warnings of the cloud-run target: a stop budget (the stop time limit plus the drain delay, with the Cloud Run
 * defaults where the project sets none) over 9 seconds, and jobs or database queues while the CPU is throttled.
 */
export function cloudRunWarnings(project: { lifecycle?: { stopTimeout?: string }; health?: unknown }, config: ResolvedConfig, background: boolean): string[] {
  const fitted = cloudRunConfig(project);
  const health = config.features.find((feature) => feature.key === "health");
  const drain = health ? (parseDuration((fitted.health as { drainDelay?: string } | undefined)?.drainDelay ?? CLOUD_RUN_DRAIN_DELAY) ?? 0) : 0;
  const stop = parseDuration(fitted.lifecycle?.stopTimeout ?? CLOUD_RUN_STOP_TIMEOUT) ?? 0;
  const cpu = deployOptionsOf(config)?.cloudRun.cpuAlwaysAllocated === true;
  return [...(stop + drain > 9000 ? [CLOUD_RUN_STOP_WARNING] : []), ...(background && !cpu ? [CLOUD_RUN_BACKGROUND_WARNING] : [])];
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

/** What bundling the service produced, and the input the `beforeBundle` hooks left. */
interface Bundled {
  modules: ModuleSize[];
  input: BundleInput;
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
    // The service knows the target it runs on, so options like connections.mode "auto" follow it.
    `process.env.QS_DEPLOY_TARGET ??= ${JSON.stringify({ runLambda: "lambda", runAzureFunctions: "azure-functions", runCloudRun: "cloud-run" }[runner] ?? "server")};`,
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
async function bundle(entry: string, outdir: string, target: string, external: readonly string[], naming = "server.js", beforeBundle: readonly FeatureHook<BundleInput, undefined>[] = []): Promise<Bundled> {
  const input = await runBeforeHooks(beforeBundle, { target, entrypoints: [entry], external: [...external], define: {} }, undefined);
  const result = await Bun.build({ entrypoints: input.entrypoints, outdir, target: "bun", naming, minify: true, sourcemap: "linked", external: input.external, define: input.define, metafile: true, throw: false });
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
  return { modules: [...bytes].map(([path, size]) => ({ path, bytes: size })).sort((a, b) => b.bytes - a.bytes), input };
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
export async function compileBinary(root: string, dir: string, file: string, platform: string, target: string, external: readonly string[], entry: string, beforeBundle: readonly FeatureHook<BundleInput, undefined>[] = []): Promise<Bundled> {
  if (external.length > 0) throw new BuildError(unbundleable(external[0]!, target));
  // Bundling first checks every module and measures them; the compiled executable embeds the same graph.
  const scratch = mkdtempSync(join(tmpdir(), "qs-compile-"));
  try {
    const bundled = await bundle(entry, scratch, target, external, "server.js", beforeBundle);
    if (bundled.input.external.length > 0) throw new BuildError(unbundleable(bundled.input.external[0]!, target));
    const defines = Object.entries(bundled.input.define).flatMap(([name, value]) => ["--define", `${name}=${value}`]);
    const compiled = Bun.spawnSync([process.execPath, "build", bundled.input.entrypoints[0]!, "--compile", "--minify", ...defines, `--target=bun-${platform}`, "--outfile", join(dir, file)], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (compiled.exitCode !== 0) throw new BuildError(`Compiling for ${platform} failed:\n${compiled.stderr.toString()}${compiled.stdout.toString()}`);
    return bundled;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The project files that replace the generated ones of a target: `deploy/<target>/entry.ts` and support files. */
export function targetOverrides(root: string, target: string): { entry?: string; files: string[] } {
  const dir = join(root, "deploy", target);
  const files = filesUnder(dir);
  return { ...(files.includes("entry.ts") ? { entry: join(dir, "entry.ts") } : {}), files: files.filter((file) => file !== "entry.ts") };
}

/** The line printed for a project file replacing a generated one. */
export const deployOverrideLine = (target: string, name: string) => `Override: deploy/${target}/${name} replaces the generated ${name}`;

/** What `writeDeployOutput` accepts besides the project, the config and the target. */
export interface DeployBuildOptions {
  /** Also writes `<outDir>/<target>/bundle-report.json` with every module's size. */
  analyze?: boolean;
  /** The project's jobs with their schedules, for the targets that write a function per job. */
  jobs?: readonly { name: string; schedule: unknown }[];
  /** The project's triggers with their source references, for the targets that write a function per trigger. */
  triggers?: readonly { name: string; source: TriggerSourceRef }[];
  /** The paths of the project's routes, generated and custom, for the targets whose function names could collide. */
  routes?: readonly string[];
  /** Prints the lines a custom target logs. */
  log?: (line: string) => void;
}

/** The Knative `service.yaml` of the cloud-run target. */
export function cloudRunService(name: string, port: number, options: DeployOptions["cloudRun"], live: string | undefined): string {
  const probe = (kind: string) => [`          ${kind}:`, "            httpGet:", `              path: ${live}`, `              port: ${port}`];
  return [
    "# Generated by quickservicets build. Do not edit.",
    "apiVersion: serving.knative.dev/v1",
    "kind: Service",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  template:",
    "    metadata:",
    "      annotations:",
    `        autoscaling.knative.dev/minScale: "${options.minInstances}"`,
    `        autoscaling.knative.dev/maxScale: "${options.maxInstances}"`,
    `        run.googleapis.com/cpu-throttling: "${!options.cpuAlwaysAllocated}"`,
    "    spec:",
    `      containerConcurrency: ${options.concurrency}`,
    `      timeoutSeconds: ${Math.round((parseDuration(options.timeout) ?? 300_000) / 1000)}`,
    "      containers:",
    `        - image: ${name}`,
    "          ports:",
    `            - containerPort: ${port}`,
    "          resources:",
    "            limits:",
    `              cpu: "${options.cpu}"`,
    `              memory: ${options.memory}`,
    ...(live ? [...probe("startupProbe"), ...probe("livenessProbe")] : []),
    "",
  ].join("\n");
}

/** One trigger of the project with the Azure binding its source describes, or none when it has none. */
export interface AzureTriggerBinding {
  name: string;
  kind: string;
  binding?: Record<string, unknown>;
}

/** The message of a trigger whose source has no Azure binding. */
export const noAzureBinding = (name: string, kind: string) => `triggers/${name}: source ${kind} cannot run on azure-functions`;

/** Each trigger with the Azure binding its source's `describe(ref).azure` gives. */
export async function azureTriggerBindings(config: ResolvedConfig, triggers: readonly { name: string; source: TriggerSourceRef }[]): Promise<AzureTriggerBinding[]> {
  if (triggers.length === 0) return [];
  const sources = await triggerSources(config);
  return triggers.map(({ name, source: ref }) => {
    const binding = sources.get(ref.kind)?.describe?.(ref as never)?.azure;
    return { name, kind: ref.kind, ...(binding ? { binding: binding as Record<string, unknown> } : {}) };
  });
}

/** The files of the azure-functions target besides the binary, the timer functions with their jobs and the trigger functions with their triggers. */
export function azureFunctionFiles(executable: string, options: NonNullable<DeployOptions["azure"]>, jobs: readonly { name: string; schedule: unknown }[], routes: readonly string[], triggerBindings: readonly AzureTriggerBinding[] = []): { files: Record<string, string>; timers: Record<string, string>; triggers: Record<string, string> } {
  const timers: Record<string, string> = {};
  const triggers: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const trigger of triggerBindings) {
    if (!trigger.binding) throw new BuildError(noAzureBinding(trigger.name, trigger.kind));
    const name = triggerFunctionName(trigger.name);
    triggers[name] = trigger.name;
    files[`${name}/function.json`] = `${JSON.stringify({ bindings: [{ name: "event", direction: "in", ...trigger.binding }] }, null, 2)}\n`;
  }
  for (const job of jobs) {
    const schedule = ncrontab(job.schedule);
    if ("error" in schedule) throw new BuildError(`jobs/${job.name}: ${schedule.error}`);
    const name = timerFunctionName(job.name);
    timers[name] = job.name;
    files[`${name}/function.json`] = `${JSON.stringify({ bindings: [{ name: "timer", type: "timerTrigger", direction: "in", schedule: schedule.cron }] }, null, 2)}\n`;
  }
  for (const name of ["http", ...Object.keys(timers), ...Object.keys(triggers)]) {
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
  return { files, timers, triggers };
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
  const beforeBundle = options?.beforeBundle ?? [];
  const overrides = targetOverrides(root, target);
  const overrideLines: string[] = overrides.entry ? [deployOverrideLine(target, "entry.ts")] : [];
  /** The entry of a target: the project's `deploy/<target>/entry.ts`, or the generated one. */
  const entryOf = (generated: () => string) => overrides.entry ?? generated();
  const custom = target in (options?.targets ?? {}) || featureTargets().has(target);
  let bundled: Bundled;
  if (target === "binary") {
    const platform = options?.platform ?? defaultPlatform(target);
    bundled = await compileBinary(root, dir, binaryName(serviceName(root, options), platform), platform, target, external, entryOf(() => writeEntry(root, assets, true)), beforeBundle);
  } else if (target === "lambda") {
    const lambda = options?.lambda ?? { architecture: "arm64", streaming: false };
    // The bootstrap runs on Amazon Linux; deploy.platform, when set, wins (a local platform runs it outside AWS).
    const platform = options?.platform ?? (lambda.architecture === "x86_64" ? "linux-x64" : "linux-arm64");
    bundled = await compileBinary(root, dir, "bootstrap", platform, target, external, entryOf(() => writePlatformEntry(root, assets, `runLambda(inputs, ${JSON.stringify({ streaming: lambda.streaming })})`)), beforeBundle);
    writeFileSync(join(dir, "function.zip"), zipArchive([{ name: "bootstrap", data: new Uint8Array(readFileSync(join(dir, "bootstrap"))), mode: 0o755 }]));
  } else if (target === "azure-functions") {
    const platform = options?.platform ?? defaultPlatform(target);
    const executable = binaryName(serviceName(root, options), platform);
    const bindings = await azureTriggerBindings(config, build.triggers ?? []);
    const { files, timers, triggers } = azureFunctionFiles(executable, options?.azure ?? { authLevel: "anonymous", extensionBundle: true }, build.jobs ?? [], build.routes ?? [], bindings);
    bundled = await compileBinary(root, dir, executable, platform, target, external, entryOf(() => writePlatformEntry(root, assets, `runAzureFunctions(inputs, ${JSON.stringify({ jobs: timers, ...(Object.keys(triggers).length > 0 ? { triggers } : {}) })})`)), beforeBundle);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
  } else if (target === "cloud-run") {
    const platform = options?.platform ?? defaultPlatform(target);
    const name = serviceName(root, options);
    const executable = binaryName(name, platform);
    const cloudRun = options!.cloudRun;
    bundled = await compileBinary(root, dir, executable, platform, target, external, entryOf(() => writePlatformEntry(root, assets, `runCloudRun(inputs, ${JSON.stringify({ scheduledWork: cloudRun.cpuAlwaysAllocated, trustProxy: cloudRun.trustProxy })})`)), beforeBundle);
    const health = config.features.find((feature) => feature.key === "health");
    const files = dockerfile({ artifact: executable, base: "distroless", user: 10001, port: 8080 });
    writeFileSync(join(dir, "Dockerfile"), files.dockerfile);
    writeFileSync(join(dir, ".dockerignore"), files.dockerignore);
    writeFileSync(join(dir, "service.yaml"), cloudRunService(name, 8080, cloudRun, health ? String(health.options.live) : undefined));
  } else {
    bundled = await bundle(entryOf(() => writeEntry(root, assets, false)), dir, target, external, "server.js", beforeBundle);
    copyAssets(dir, assets);
    if (custom) {
      // A target of the project or a feature writes its output from the bundled service.
      const added = options?.targets?.[target] ?? featureTargets().get(target)!.target;
      await added.build({ bundle: join(dir, "server.js"), outDir: dir, options: options!, log: (line) => void build.log?.(line) });
    }
  }
  // Project files in deploy/<target>/ replace the generated files of the same name.
  for (const file of overrides.files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, "deploy", target, file), join(dir, file));
    overrideLines.push(deployOverrideLine(target, file));
  }
  const files = filesUnder(dir);
  const size = files.reduce((total, file) => total + statSync(join(dir, file)).size, 0);
  if (build.analyze) writeFileSync(join(dir, "bundle-report.json"), `${JSON.stringify({ target, size, modules: bundled.modules }, null, 2)}\n`);
  await runAfterHooks(options?.afterBundle ?? [], { target, files, sizes: Object.fromEntries(files.map((file) => [file, statSync(join(dir, file)).size])) }, undefined);
  return { overrides: overrideLines, target, dir: `${relative(root, dir)}/`, size, files: build.analyze ? [...files, "bundle-report.json"].sort() : files, modules: bundled.modules.slice(0, 5) };
}

/** The lines naming the largest modules of a bundle. */
export function largestModuleLines(modules: readonly ModuleSize[]): string[] {
  return modules.length === 0 ? [] : ["Largest modules:", ...modules.slice(0, 5).map((module) => `  ${module.path} (${formatSize(module.bytes)})`)];
}

/** The line a build prints for its target: `Target server: dist/server/ (1.2 MB)`. */
export const targetLine = (output: Pick<DeployOutput, "target" | "dir" | "size">) => `Target ${output.target}: ${output.dir} (${formatSize(output.size)})`;

/** Reads a file of the output, for tests and later steps. */
export const readOutput = (root: string, output: DeployOutput, file: string) => readFileSync(join(root, output.dir, file), "utf8");
