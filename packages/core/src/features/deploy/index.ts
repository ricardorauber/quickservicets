import { defineFeature, object, oneOf, platformOf, string } from "../public.ts";

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
}

const options = object({
  target: oneOf(DEPLOY_TARGETS).default("server").describe("The platform `quickservicets build` writes the deployable output for: server, binary, lambda, azure-functions or cloud-run; `--target` wins over it."),
  outDir: string().default("dist").describe("The folder of the deployable output; each target writes `<outDir>/<target>/`."),
  name: string().optional().describe("The name of the deployed service and its artifacts (default: the package name without its scope)."),
  platform: oneOf(DEPLOY_PLATFORMS)
    .optional()
    .describe("The operating system and CPU of compiled binaries (default: the build machine for server and binary, linux-arm64 for lambda, linux-x64 for azure-functions and cloud-run)."),
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

export default deployFeature;
