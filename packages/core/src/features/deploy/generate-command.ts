import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { boolean, defineCommand, FEATURES_DIR, isTriggerDefinition, NATIVE_FEATURES_DIR, object, setUpDependents, type ResolvedConfig, type TriggerSourceRef } from "../public.ts";
import { clearDeployGenerators, deployGenerators, NO_GENERATORS, runDeployGenerator } from "./generators.ts";
import { describeDeployment, type DeploymentInputs } from "./model.ts";

/** The jobs, triggers and queues of the project's last build, read from `.generated/`; empty without a build. */
export async function lastBuildInputs(root: string): Promise<Pick<DeploymentInputs, "jobs" | "triggers" | "queues">> {
  const generated = join(root, ".generated");
  const inputs: Pick<DeploymentInputs, "jobs" | "triggers" | "queues"> = {};
  if (existsSync(join(generated, "jobs.ts"))) {
    const { jobs } = (await import(join(generated, "jobs.ts"))) as { jobs?: ReadonlyMap<string, { schedule: unknown }> };
    inputs.jobs = [...(jobs ?? new Map())].map(([name, job]) => ({ name, schedule: job.schedule }));
  }
  if (existsSync(join(generated, "features.ts"))) {
    const { featureFolders } = (await import(join(generated, "features.ts"))) as { featureFolders?: Record<string, Record<string, ReadonlyMap<string, unknown>>> };
    inputs.triggers = [...(featureFolders?.triggers?.triggers ?? new Map())].flatMap(([name, value]) => (isTriggerDefinition(value) ? [{ name, source: value.source as TriggerSourceRef }] : []));
    inputs.queues = [...(featureFolders?.queues?.queues ?? new Map()).keys()];
  }
  return inputs;
}

/** The files of a feature's `templates/` folder (in the project's feature folder, or the native's), by relative path. */
export function featureTemplates(root: string, key: string): Record<string, string> {
  const folder = [join(root, FEATURES_DIR, key, "templates"), join(NATIVE_FEATURES_DIR, key, "templates")].find((candidate) => existsSync(candidate));
  if (!folder) return {};
  const templates: Record<string, string> = {};
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) templates[relative(folder, join(entry.parentPath, entry.name)).split("\\").join("/")] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return templates;
}

/** What one generation run did: the files written (or, with `check`, that would change), relative to the project. */
export interface GenerationResult {
  changed: string[];
}

/**
 * Runs the named generators (every registered one without keys) on the deployment model of the config and writes
 * their files under the project, only those whose content changed; with `check`, writes nothing and resolves the files
 * that would change.
 */
export async function generateDeployment(root: string, config: ResolvedConfig, keys: readonly string[], options: { check?: boolean; env?: Record<string, string | undefined> } = {}): Promise<GenerationResult> {
  clearDeployGenerators();
  const stop = await setUpDependents(config, "deploy");
  try {
    const registered = deployGenerators();
    if (registered.size === 0) throw new Error(NO_GENERATORS);
    const unknown = keys.filter((key) => !registered.has(key));
    if (unknown.length > 0) throw new Error(`Unknown deploy generator ${unknown.join(", ")}; registered: ${[...registered.keys()].join(", ")}`);
    const model = await describeDeployment(config, { root, ...(options.env ? { env: options.env } : {}), ...(await lastBuildInputs(root)) });
    const changed: string[] = [];
    for (const key of keys.length > 0 ? keys : [...registered.keys()]) {
      const { generator, owner } = registered.get(key)!;
      const featureOptions = (config.features.find((feature) => feature.key === owner)?.options ?? {}) as Record<string, unknown>;
      const { out, files } = await runDeployGenerator(key, generator, model, { options: featureOptions, templates: featureTemplates(root, owner) });
      for (const [path, content] of files) {
        const file = join(root, out, path);
        if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
        changed.push(`${out}/${path}`);
        if (options.check) continue;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    return { changed };
  } finally {
    await stop();
    clearDeployGenerators();
  }
}

/** `quickservicets deploy generate [keys…] [--check]`. */
export const deployGenerateCommand = defineCommand({
  name: "deploy generate",
  usage: "quickservicets deploy generate [keys…] [--check]",
  description: "Writes the files of the deploy generators (all registered ones, or the named keys), each into its folder under deploy/, from the deployment model of quickservicets.config.ts, only those that changed; --check writes nothing and exits 1 listing the files that would change.",
  args: [{ name: "keys", variadic: true, description: "The generators to run (default: every registered one)." }],
  flags: object({ check: boolean().default(false).describe("Writes nothing and exits 1 when a generated file would change.") }),
  json: { changed: ["string"] },
  async run(ctx) {
    const keys = (ctx.args.keys ?? "").split(/\s+/).filter(Boolean);
    let result: GenerationResult;
    try {
      result = await generateDeployment(ctx.cwd, ctx.config, keys, { check: ctx.flags.check });
    } catch (error) {
      ctx.output.error((error as Error).message);
      return 1;
    }
    ctx.result({ changed: result.changed });
    if (ctx.flags.check) {
      for (const file of result.changed) ctx.output.log(`${file} would change`);
      if (result.changed.length === 0) ctx.output.log("Generated deployment files are up to date");
      return result.changed.length > 0 ? 1 : 0;
    }
    for (const file of result.changed) ctx.output.log(`Wrote ${file}`);
    if (result.changed.length === 0) ctx.output.log("Generated deployment files are up to date");
    return 0;
  },
});
