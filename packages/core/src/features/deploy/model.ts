import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configSecretReferences, declaredVariables, describeInfrastructure, triggerSources, type InfraService, type ResolvedConfig, type TriggerSourceHints, type TriggerSourceRef } from "../public.ts";

/** What a deployment ships: the build output of its target. */
export interface DeploymentArtifact {
  target: string;
  /** The output folder relative to the project, like `dist/server/`. */
  dir: string;
  /** The file to deploy or run: `server.js`, a binary, `function.zip`, or the folder itself for azure-functions. */
  file: string;
  /** `bundle` (run with Bun), `binary`, `zip` (a Lambda package), `functions` (an Azure Functions folder) or `image` (built from the folder's Dockerfile). */
  kind: "bundle" | "binary" | "zip" | "functions" | "image";
  /** The platform of compiled binaries. */
  platform?: string;
}

/** A variable the service reads that is not secret, with its value or the template it is built from. */
export interface DeploymentVariable {
  name: string;
  /** Its value in the build environment, when it has one. */
  value?: string;
  /** How the value is built from a service's endpoint, like `postgres://{user}:{password}@{host}:{port}/{database}`. */
  template?: string;
  /** `declared` (the project's or a feature's `env`), `override` (a `QS_*` variable of the build environment) or `infra` (a required service). */
  source: "declared" | "override" | "infra";
}

/** A secret the service needs: its variable or option, and the reference text that reads it, never its value. */
export interface DeploymentSecret {
  /** The variable, like `STRIPE_KEY`, or the option path, like `http.services.billing.auth.bearer`. */
  name: string;
  /** The reference that reads it, like `env://STRIPE_KEY` or `vault://kv/db#url`; null when none is configured. */
  reference: string | null;
  source: "variable" | "option" | "infra";
}

/** What a deployment of the service needs, built from the config, from which every generator writes its files. */
export interface DeploymentModel {
  name: string;
  version: string;
  target: string;
  artifact: DeploymentArtifact;
  port: number;
  workers: number;
  env: DeploymentVariable[];
  secrets: DeploymentSecret[];
  /** The external services of the infrastructure description. */
  services: InfraService[];
  /** The probes and shutdown timings, while the `health` native is enabled. */
  health?: { live: string; ready: string; drainDelay: string; stopTimeout: string };
  /** The command that applies the migrations with the artifact, or null for targets that cannot run one. */
  migrate: string | null;
  /** Each scheduled job with its cron expression or interval. */
  schedules: { job: string; cron?: string; every?: string }[];
  /** Each trigger with its source kind and the platform hints of its source's `describe`. */
  triggers: { name: string; kind: string; hints: TriggerSourceHints }[];
  /** The storage buckets in use. */
  buckets: { storage: string; kind: string; bucket: string }[];
  /** The queues in use, with the broker that carries them. */
  queues: { name: string; broker: string }[];
}

/** What the project gives the model besides the config: what its last build found. */
export interface DeploymentInputs {
  /** The project's root (default: the working directory), for its package.json. */
  root?: string;
  /** The environment of the build (default: `process.env`), for the `QS_*` overrides and declared values. */
  env?: Record<string, string | undefined>;
  /** The jobs with their schedules. */
  jobs?: readonly { name: string; schedule: unknown }[];
  /** The triggers with their source references. */
  triggers?: readonly { name: string; source: TriggerSourceRef }[];
  /** The queue names. */
  queues?: readonly string[];
}

const packageOf = (root: string): { name?: string; version?: string } => {
  const file = join(root, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string }) : {};
};

/** The deploy native's options the model reads. */
type DeployOptionsLike = { target?: string; outDir?: string; name?: string; platform?: string; lambda?: { architecture?: string } };

/** The artifact of a target, as `quickservicets build --target` writes it. */
function artifactOf(target: string, name: string, options: DeployOptionsLike): DeploymentArtifact {
  const dir = `${options.outDir ?? "dist"}/${target}/`;
  const platform = options.platform;
  const exe = (platform ?? "").startsWith("windows") ? `${name}.exe` : name;
  if (target === "server") return { target, dir, file: "server.js", kind: "bundle" };
  if (target === "binary") return { target, dir, file: exe, kind: "binary", ...(platform ? { platform } : {}) };
  if (target === "lambda") return { target, dir, file: "function.zip", kind: "zip", platform: platform ?? (options.lambda?.architecture === "x86_64" ? "linux-x64" : "linux-arm64") };
  if (target === "azure-functions") return { target, dir, file: ".", kind: "functions", platform: platform ?? "linux-x64" };
  if (target === "cloud-run") return { target, dir, file: "Dockerfile", kind: "image", platform: platform ?? "linux-x64" };
  return { target, dir, file: "server.js", kind: "bundle" };
}

/** The command that migrates with the artifact: the bundle's and binaries' `migrate` subcommand; null on function targets. */
function migrateOf(artifact: DeploymentArtifact): string | null {
  if (artifact.kind === "bundle") return `bun ${artifact.dir}${artifact.file} migrate`;
  if (artifact.kind === "binary") return `./${artifact.file} migrate`;
  if (artifact.kind === "image") return "migrate";
  return null;
}

const SECRET_TEMPLATE = /\{password\}/;

/** A schedule as the model lists it: a cron text, or an interval. */
function scheduleOf(job: string, schedule: unknown): { job: string; cron?: string; every?: string } {
  if (typeof schedule === "string") return { job, cron: schedule };
  const every = (schedule as { every?: unknown } | null)?.every;
  return typeof every === "string" ? { job, every } : { job };
}

/**
 * Describes what a deployment of the service needs, from its resolved config and what its last build found: the
 * artifact of the target, the port and workers, the variables (with values or templates) and the secrets (with their
 * reference text, never a value), the external services, the probes, the migrate command, the schedules, the triggers
 * with their source hints, and the buckets and queues in use. It connects to nothing.
 */
export async function describeDeployment(config: ResolvedConfig, inputs: DeploymentInputs = {}): Promise<DeploymentModel> {
  const root = inputs.root ?? process.cwd();
  const env = inputs.env ?? process.env;
  const pkg = packageOf(root);
  const deploy = (config.features.find((feature) => feature.key === "deploy")?.options ?? {}) as DeployOptionsLike;
  const name = deploy.name ?? (pkg.name ?? "").replace(/^@[^/]+\//, "") ?? "service";
  const target = deploy.target ?? "server";
  const artifact = artifactOf(target, name || "service", deploy);
  const references = configSecretReferences(config);
  const referenceTexts = new Set(references.map((found) => found.reference.text));
  const variables: DeploymentVariable[] = [];
  const secrets: DeploymentSecret[] = [];
  const seen = new Set<string>();
  // The variables the project and the features declare: secrets by their kind, the others with their values.
  for (const variable of declaredVariables(config.env, config.features.map((feature) => ({ key: feature.key, env: feature.definition.env })))) {
    seen.add(variable.name);
    const reference = `env://${variable.name}`;
    if (variable.schema.kind === "secret") secrets.push({ name: variable.name, reference: referenceTexts.has(reference) ? reference : null, source: "variable" });
    else variables.push({ name: variable.name, ...(env[variable.name] !== undefined ? { value: env[variable.name]! } : {}), source: "declared" });
  }
  // The infrastructure's variables: a template carrying credentials is a secret.
  const infra = describeInfrastructure(config as never);
  for (const [variable, template] of Object.entries(infra.env)) {
    if (seen.has(variable)) continue;
    seen.add(variable);
    const reference = `env://${variable}`;
    if (SECRET_TEMPLATE.test(template)) secrets.push({ name: variable, reference: referenceTexts.has(reference) ? reference : null, source: "infra" });
    else variables.push({ name: variable, template, source: "infra" });
  }
  // The QS_* overrides of the build environment are part of the deployment.
  for (const [variable, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!variable.startsWith("QS_") || value === undefined || seen.has(variable)) continue;
    seen.add(variable);
    variables.push({ name: variable, value, source: "override" });
  }
  // Secret options of the config, by path; the database URL counts as the infrastructure's variable when it has one.
  for (const found of references) {
    if (secrets.some((secret) => secret.reference === found.reference.text)) continue;
    secrets.push({ name: found.path, reference: found.reference.text, source: "option" });
  }
  const health = config.features.find((feature) => feature.key === "health")?.options as { live?: string; ready?: string; drainDelay?: string } | undefined;
  const sources = (inputs.triggers?.length ?? 0) > 0 ? await triggerSources(config) : new Map();
  const queuesFeature = config.features.find((feature) => feature.key === "queues");
  const broker = (queuesFeature?.options.broker as { name?: string } | undefined)?.name ?? (queuesFeature?.options.broker ? "custom" : "database");
  const buckets: DeploymentModel["buckets"] = [];
  for (const [storage, adapter] of Object.entries((config.storage ?? {}) as Record<string, { describe?: () => { kind?: string; bucket?: string } }>)) {
    const described = adapter?.describe?.();
    if (described?.bucket) buckets.push({ storage, kind: described.kind ?? "custom", bucket: described.bucket });
  }
  return {
    name: name || "service",
    version: pkg.version ?? "0.0.0",
    target,
    artifact,
    port: config.server.port,
    workers: config.server.workers,
    env: variables,
    secrets,
    services: infra.services,
    ...(health ? { health: { live: String(health.live), ready: String(health.ready), drainDelay: String(health.drainDelay), stopTimeout: config.lifecycle.stopTimeout } } : {}),
    migrate: migrateOf(artifact),
    schedules: (inputs.jobs ?? []).map((job) => scheduleOf(job.name, job.schedule)),
    triggers: (inputs.triggers ?? []).map((trigger) => ({ name: trigger.name, kind: trigger.source.kind, hints: (sources.get(trigger.source.kind)?.describe?.(trigger.source as never) ?? {}) as TriggerSourceHints })),
    buckets,
    queues: queuesFeature ? (inputs.queues ?? []).map((queue) => ({ name: queue, broker })) : [],
  };
}
