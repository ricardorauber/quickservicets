import { boolean, defineFeature, duration, integer, list, object, oneOf, platformOf, string } from "../public.ts";

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
  }).describe("Settings of the lambda target."),
  azure: object({
    authLevel: oneOf(["anonymous", "function"] as const).default("anonymous").describe("The authLevel of the HTTP function: anonymous, or function to require a function key."),
    functionTimeout: duration().optional().describe("The functionTimeout written to host.json, like 10m (default: the plan's)."),
    extensionBundle: boolean().default(true).describe("Adds the default extension bundle to host.json, so trigger bindings resolve."),
  }).describe("Settings of the azure-functions target."),
  cloudRun: object({
    concurrency: integer().min(1).max(1000).default(80).describe("The most requests one container serves at once (containerConcurrency)."),
    timeout: duration().default("300s").describe("How long a request may take before Cloud Run ends it (timeoutSeconds)."),
    minInstances: integer().min(0).default(0).describe("The fewest containers kept running (autoscaling.knative.dev/minScale)."),
    maxInstances: integer().min(1).default(100).describe("The most containers Cloud Run starts (autoscaling.knative.dev/maxScale)."),
    cpuAlwaysAllocated: boolean().default(false).describe("Keeps the CPU allocated outside requests, so the job scheduler and queue consumers run (run.googleapis.com/cpu-throttling: false)."),
    memory: string().default("512Mi").describe("The memory limit of the container."),
    cpu: string().default("1").describe("The CPU limit of the container."),
    trustProxy: boolean().default(true).describe("Takes req.ip from the x-forwarded-for entry Google's front end adds, without listing proxy ranges in security.proxy.trust."),
  }).describe("Settings of the cloud-run target."),
});

/**
 * The `deploy` native: `quickservicets build --target <target>` writes the project's deployable output for a
 * long-running server, a self-contained binary, AWS Lambda, Azure Functions or Google Cloud Run. Enabled by default;
 * it acts only at build time and adds nothing to a running service.
 */
export const deployFeature = defineFeature({
  key: "deploy",
  docs: { summary: "Deploy targets: `quickservicets build --target <target>` writes the deployable output for a server, a binary, AWS Lambda, Azure Functions or Google Cloud Run." },
  enabledByDefault: true,
  options,
  // The platform handler's data about each request, computed on first read.
  request: { platform: (req) => platformOf(req.raw) },
});

export { dockerfile, RUNTIME_IMAGES } from "./dockerfile.ts";
export type { DockerfileOptions } from "./dockerfile.ts";

export default deployFeature;
