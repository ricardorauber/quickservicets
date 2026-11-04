import { boolean, defineFeature, duration, hook, integer, list, object, oneOf, platformOf, provider, record, string, type FeatureHook } from "../public.ts";

/** What a custom deploy target's `build` receives. */
export interface DeployTargetContext {
  /** The service bundled for Bun: `server.js`, with its runtime files in `assets/` next to it. */
  bundle: string;
  /** The target's output folder, `<outDir>/<name>/`, which holds the bundle. */
  outDir: string;
  /** The `deploy` native's resolved options. */
  options: DeployOptions;
  /** Prints a line of the build. */
  log(line: string): void;
}

/** A deploy target a feature or the project adds, used with `--target <name>`. */
export interface DeployTarget {
  /** Writes the target's output into `outDir`, starting from the bundled service. */
  build(context: DeployTargetContext): void | Promise<void>;
}

/** What `beforeBundle` receives, and may return changed. */
export interface BundleInput {
  target: string;
  entrypoints: string[];
  external: string[];
  /** Replacements of identifiers in the bundled code, like `{ "process.env.REGION": '"eu"' }`. */
  define: Record<string, string>;
}

/** What `afterBundle` receives. */
export interface BundleOutput {
  target: string;
  /** The output files, relative to the target's folder. */
  files: string[];
  /** The size of each output file in bytes. */
  sizes: Record<string, number>;
}

/** What `onPlatformEvent` receives: a non-HTTP event of a platform, before it is dispatched. */
export interface PlatformEvent {
  target: string;
  event: unknown;
}

/** The setup API of the `deploy` native. */
export interface DeployApi {
  /** Adds a deploy target the build accepts with `--target <name>`. */
  target(name: string, target: DeployTarget): void;
  addHook(name: "beforeBundle", fn: FeatureHook<BundleInput, undefined>): void;
  addHook(name: "afterBundle", fn: FeatureHook<BundleOutput, undefined>): void;
  addHook(name: "onPlatformEvent", fn: FeatureHook<PlatformEvent, undefined>): void;
}

/** The targets features added with `ctx.feature("deploy").target`, by name, with the feature that added each. */
const addedTargets = new Map<string, { owner: string; target: DeployTarget }>();

/** The targets features added through the setup API, by name. */
export function featureTargets(): ReadonlyMap<string, { owner: string; target: DeployTarget }> {
  return addedTargets;
}

/** Forgets the targets features added, before a build runs their setups again. */
export function clearFeatureTargets(): void {
  addedTargets.clear();
}

/**
 * Registers a target for an owner, failing when the name is a built-in target or another owner registered it:
 * `Deploy target <name> of <owner> conflicts with <other owner>`.
 */
export function addDeployTarget(name: string, target: DeployTarget, owner: string): void {
  if ((DEPLOY_TARGETS as readonly string[]).includes(name)) throw new Error(`Deploy target ${name} of ${owner} conflicts with the built-in ${name} target`);
  const previous = addedTargets.get(name);
  if (previous) throw new Error(`Deploy target ${name} of ${owner} conflicts with ${previous.owner}`);
  if (typeof target?.build !== "function") throw new Error(`Deploy target ${name} of ${owner} must have a build function`);
  addedTargets.set(name, { owner, target });
}

/** The deploy targets a project builds for. */
export const DEPLOY_TARGETS = ["server", "binary", "lambda", "azure-functions", "cloud-run"] as const;

/** A deploy target. */
export type DeployTargetName = (typeof DEPLOY_TARGETS)[number];

/** The platforms a binary is compiled for. */
export const DEPLOY_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;

/** A platform of a compiled binary. */
export type DeployPlatform = (typeof DEPLOY_PLATFORMS)[number];

/** The targets that run as functions: one process, driven by the platform's invocations. */
export const FUNCTION_TARGETS: readonly string[] = ["lambda", "azure-functions"];

/** Whether a target runs the service in function mode. */
export const isFunctionTarget = (target: string): boolean => FUNCTION_TARGETS.includes(target);

/** The message of a target that is not one of the deploy targets. */
export const unknownTarget = (value: string) => `Unknown deploy target ${value}; use server, binary, lambda, azure-functions or cloud-run`;

/** The message of a target other than `server` while the native is off. */
export const DEPLOY_DISABLED = "deploy is disabled (deploy: false in quickservicets.config.ts)";

/** The platform of the machine running the build, as a deploy platform. */
export function buildMachinePlatform(): DeployPlatform {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}` as DeployPlatform;
}

/** The platform a target builds for when `deploy.platform` is not set. */
export function defaultPlatform(target: string): DeployPlatform {
  if (target === "lambda") return "linux-arm64";
  if (target === "azure-functions" || target === "cloud-run") return "linux-x64";
  return buildMachinePlatform();
}

/** The resolved options of the `deploy` native. */
export interface DeployOptions {
  target: DeployTargetName;
  outDir: string;
  name?: string;
  platform?: DeployPlatform;
  external: string[];
  lazyRoutes: "auto" | "on" | "off";
  startupTrace: boolean;
  lambda: { architecture: "arm64" | "x86_64"; streaming: boolean };
  targets: Record<string, DeployTarget>;
  beforeBundle: FeatureHook<BundleInput, undefined>[];
  afterBundle: FeatureHook<BundleOutput, undefined>[];
  onPlatformEvent: FeatureHook<PlatformEvent, undefined>[];
  azure: { authLevel: "anonymous" | "function"; functionTimeout?: string; extensionBundle: boolean };
  cloudRun: { concurrency: number; timeout: string; minInstances: number; maxInstances: number; cpuAlwaysAllocated: boolean; memory: string; cpu: string; trustProxy: boolean };
}

/** The targets whose route tables import endpoint modules on first use when `lazyRoutes` is `auto`. */
export const LAZY_ROUTE_TARGETS: readonly string[] = ["lambda", "azure-functions", "cloud-run"];

/** Whether a target's generated route table imports endpoint modules on their first request. */
export const lazyRoutesFor = (mode: "auto" | "on" | "off", target: string): boolean => mode === "on" || (mode === "auto" && LAZY_ROUTE_TARGETS.includes(target));

const options = object({
  target: oneOf(DEPLOY_TARGETS).default("server").describe("The platform `quickservicets build` writes the deployable output for: server, binary, lambda, azure-functions or cloud-run; `--target` wins over it."),
  outDir: string().default("dist").describe("The folder of the deployable output; each target writes `<outDir>/<target>/`."),
  name: string().optional().describe("The name of the deployed service and its artifacts (default: the package name without its scope)."),
  platform: oneOf(DEPLOY_PLATFORMS)
    .optional()
    .describe("The operating system and CPU of compiled binaries (default: the build machine for server and binary, linux-arm64 for lambda, linux-x64 for azure-functions and cloud-run)."),
  external: list(string().describe("A package name, like better-sqlite3."))
    .default([])
    .describe("Packages left out of the bundle, to ship next to it in node_modules (server target only); a package with a native addon must be listed."),
  lazyRoutes: oneOf(["auto", "on", "off"] as const)
    .default("auto")
    .describe("Makes the generated route table import each endpoint module on the first request matching it: on, off, or auto (on for lambda, azure-functions and cloud-run, off otherwise)."),
  startupTrace: boolean().default(false).describe("Adds each feature's setup and onStart time, in milliseconds, to the service.started log entry."),
  lambda: object({
    architecture: oneOf(["arm64", "x86_64"] as const).default("arm64").describe("The CPU of the Lambda function the bootstrap is compiled for (deploy.platform, when set, wins)."),
    streaming: boolean().default(false).describe("Sends responses with the streaming response mode, so sse.ts routes work behind function URLs with RESPONSE_STREAM."),
  })
    .default({})
    .describe("Settings of the lambda target."),
  azure: object({
    authLevel: oneOf(["anonymous", "function"] as const).default("anonymous").describe("The authLevel of the HTTP function: anonymous, or function to require a function key."),
    functionTimeout: duration().optional().describe("The functionTimeout written to host.json, like 10m (default: the plan's)."),
    extensionBundle: boolean().default(true).describe("Adds the default extension bundle to host.json, so trigger bindings resolve."),
  })
    .default({})
    .describe("Settings of the azure-functions target."),
  cloudRun: object({
    concurrency: integer().min(1).max(1000).default(80).describe("The most requests one container serves at once (containerConcurrency)."),
    timeout: duration().default("300s").describe("How long a request may take before Cloud Run ends it (timeoutSeconds)."),
    minInstances: integer().min(0).default(0).describe("The fewest containers kept running (autoscaling.knative.dev/minScale)."),
    maxInstances: integer().min(1).default(100).describe("The most containers Cloud Run starts (autoscaling.knative.dev/maxScale)."),
    cpuAlwaysAllocated: boolean().default(false).describe("Keeps the CPU allocated outside requests, so the job scheduler and queue consumers run (run.googleapis.com/cpu-throttling: false)."),
    memory: string().default("512Mi").describe("The memory limit of the container."),
    cpu: string().default("1").describe("The CPU limit of the container."),
    trustProxy: boolean().default(true).describe("Takes req.ip from the x-forwarded-for entry Google's front end adds, without listing proxy ranges in security.proxy.trust."),
  })
    .default({})
    .describe("Settings of the cloud-run target."),
  targets: record(provider<DeployTarget>("DeployTarget", ["build"]).describe("A target's build function.")).describe("More targets for --target <name>, by name; build({ bundle, outDir, options, log }) writes the output from the bundled service."),
  beforeBundle: hook<BundleInput, undefined>().describe("Runs before a target is bundled, with its target, entrypoints, external packages and define replacements; returning them changed changes the bundle."),
  afterBundle: hook<BundleOutput, undefined>().describe("Runs after a target's output is written, with its files and their sizes."),
  onPlatformEvent: hook<PlatformEvent, undefined>().describe("Runs for every non-HTTP event a platform delivers (a Lambda event, an Azure invocation) before it is dispatched; returning a result answers the event."),
});

/**
 * The `deploy` native: `quickservicets build --target <target>` writes the project's deployable output for a
 * long-running server, a self-contained binary, AWS Lambda, Azure Functions or Google Cloud Run. Enabled by default;
 * it acts only at build time and adds nothing to a running service.
 */
export const deployFeature = defineFeature({
  key: "deploy",
  docs: {
    summary: "Deploy targets: `quickservicets build --target <target>` writes the deployable output for a server, a binary, AWS Lambda, Azure Functions or Google Cloud Run.",
    sections: [
      {
        title: "Targets and their output",
        text: [
          "| Target | Output in `<outDir>/<target>/` |",
          "| --- | --- |",
          "| `server` | `server.js`, `server.js.map` and `assets/` |",
          "| `binary` | the executable `<name>` (`<name>.exe` on Windows) |",
          "| `lambda` | `bootstrap` and `function.zip` |",
          "| `azure-functions` | the executable, `host.json`, `http/function.json` and `job-<name>/function.json` per job |",
          "| `cloud-run` | the executable, `Dockerfile`, `.dockerignore` and `service.yaml` |",
        ].join("\n"),
      },
      {
        title: "Override files",
        text: "A project file `deploy/<target>/entry.ts` replaces the generated entry of that target (the bundle's entry for `server`, the platform entry of the others), and any other file in `deploy/<target>/` replaces the generated file of the same name, like `deploy/azure-functions/host.json`, `deploy/cloud-run/service.yaml` or `deploy/cloud-run/Dockerfile`. Each one prints `Override: deploy/<target>/<name> replaces the generated <name>`.",
      },
      {
        title: "The DeployTarget contract",
        text: "`targets` and `ctx.feature(\"deploy\").target(name, target)` (for features listing `deploy` in `requires` or `after`) add targets for `--target <name>`. The build first bundles the service into `<outDir>/<name>/` (`server.js` and `assets/`), then calls the target:\n\n```ts\ninterface DeployTarget {\n  build(context: { bundle: string; outDir: string; options: DeployOptions; log(line: string): void }): void | Promise<void>;\n}\n```\n\nA name equal to a built-in target, or registered twice, fails naming both owners.",
      },
    ],
  },
  enabledByDefault: true,
  options,
  // The platform handler's data about each request, computed on first read.
  request: { platform: (req) => platformOf(req.raw) },
  tags: {
    preload: {
      on: ["entity", "endpoint"],
      description: "Imports the routes' modules at startup even with lazy routes (deploy.lazyRoutes), for routes that must answer the first request fast.",
      example: "/** @preload */\nexport type Post = { title: string };",
    },
  },
  api: (ctx): DeployApi => ({
    target(name, target) {
      addDeployTarget(name, target, ctx.currentFeature() ?? "a feature");
    },
    addHook: ctx.addHook as DeployApi["addHook"],
  }),
});

export { dockerfile, RUNTIME_IMAGES } from "./dockerfile.ts";
export type { DockerfileOptions } from "./dockerfile.ts";

export default deployFeature;
