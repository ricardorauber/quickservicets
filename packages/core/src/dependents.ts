import type { ResolvedConfig } from "./config.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";

/**
 * Runs the setups of a native and of the features that list it in `requires` or `after`, outside a running service,
 * so what they add through its setup API (hooks with `addHook`, the deploy targets of `ctx.feature("deploy").target`)
 * applies to a CLI command or a build; resolves a function that stops them.
 */
export async function setUpDependents(config: ResolvedConfig, key: string): Promise<() => Promise<void>> {
  const features = config.features ?? [];
  const native = features.find((feature) => feature.key === key);
  const dependents = features.filter((feature) => feature.key !== key && (feature.definition.requires.some((requirement) => requirement.name === key) || feature.definition.after.includes(key)));
  if (!native || dependents.length === 0) return async () => {};
  const lifecycle = createFeatureLifecycle({ features: [native, ...dependents], config, models: [], worker: { index: 0, count: 1, runsScheduledWork: false }, resolveSecrets: false });
  await lifecycle.setup();
  return () => lifecycle.stop();
}
