import { ConfigError } from "./config-error.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import { boolean, object, resolveOptions, type AnyOptionSchema, type ObjectOptionSchema, type Options, type OptionsInput } from "./options.ts";

/**
 * The config keys of the native features, each typed with its options. Every native module augments it:
 *
 * ```ts
 * declare module "@quickservice/core" {
 *   interface NativeFeatures {
 *     history?: FeatureConfig<typeof history>;
 *   }
 * }
 * ```
 */
export interface NativeFeatures {}

/** Where a feature is documented. */
export interface FeatureDocs {
  /** One sentence on what the feature does. */
  summary: string;
  url?: string;
}

type AnyShape = Record<string, AnyOptionSchema>;
type EnabledShape = { enabled: ReturnType<typeof enabledOption> };
const enabledOption = () => boolean().default(true).describe("Turns the feature off when false.");

/** What `defineFeature` accepts. */
export interface FeatureInput<S extends AnyOptionSchema> {
  /** The config key that enables the feature, like `history`: lowercase letters, digits and dashes. */
  key: string;
  /** The feature's options, an `object({...})` schema (default: no options). */
  options?: S;
  docs?: FeatureDocs;
  /** Enabled without its config key; `<key>: false` still turns it off (default false). */
  enabledByDefault?: boolean;
  /** Natives that must be enabled for this feature to work; an entry may carry a hint added to the error. */
  requires?: readonly (string | FeatureRequirement)[];
  /** Natives this feature runs after when they are enabled, without needing them. */
  after?: readonly string[];
  /** Natives this feature turns on with their default options when the project's config has no key for them. */
  enables?: readonly string[];
}

/** A required native, with a hint on why it is needed. */
export interface FeatureRequirement {
  name: string;
  hint?: string;
}

/** The resolved options of a feature: its own plus the implicit `enabled`. */
export type FeatureOptions<S> = Options<S> & { enabled: boolean };

/** A feature definition, as `defineFeature` returns it. */
export interface FeatureDefinition<S extends AnyOptionSchema = AnyOptionSchema> {
  readonly key: string;
  /** The options schema, with the implicit `enabled` option. */
  readonly schema: AnyOptionSchema;
  readonly docs?: FeatureDocs;
  readonly enabledByDefault: boolean;
  readonly requires: readonly FeatureRequirement[];
  readonly after: readonly string[];
  readonly enables: readonly string[];
  /**
   * The feature's resolved options, once a configuration enabling it has been resolved in this process; throws
   * otherwise. The feature's own code reads its typed options here instead of receiving the config.
   */
  options(): FeatureOptions<S>;
}

/** The value of a feature's config key: `true`, `false`, or its options. */
export type FeatureConfig<D> = D extends FeatureDefinition<infer S> ? boolean | (OptionsInput<S> & { enabled?: boolean }) : never;

/** One enabled feature, as `config.features` lists it. */
export interface ResolvedFeature {
  key: string;
  options: Record<string, unknown> & { enabled: boolean };
  definition: FeatureDefinition;
  /** Registered with `registerNative`. */
  native: boolean;
}

/** Config keys of the core; no feature may use one. */
export const BUILT_IN_CONFIG_KEYS = [
  "database",
  "server",
  "production",
  "docs",
  "logger",
  "schema",
  "storage",
  "files",
  "repositories",
  "populate",
  "migrations",
  "jobs",
  "env",
  "plugins",
  "middleware",
  "lifecycle",
  "features",
] as const;

const FEATURE_KEY = /^[a-z][a-z0-9-]*$/;

/** Resolved options of the features enabled by the last resolved configuration. */
const resolvedOptions = new WeakMap<FeatureDefinition, Record<string, unknown>>();

/** Defines a feature: its config key, options schema and docs. */
export function defineFeature<S extends AnyOptionSchema = ObjectOptionSchema<{}>>(input: FeatureInput<S>): FeatureDefinition<S> {
  const key = input?.key;
  const invalid = (reason: string) => new Error(`Invalid feature ${String(key)}: ${reason}`);
  if (typeof key !== "string" || !FEATURE_KEY.test(key)) throw invalid("the key must match ^[a-z][a-z0-9-]*$");
  if ((BUILT_IN_CONFIG_KEYS as readonly string[]).includes(key)) throw invalid(`${key} is a built-in config key`);
  const options: AnyOptionSchema = input.options ?? object({});
  if (options.kind !== "object" || !options.settings.shape) throw invalid("options must be an object({...}) schema");
  if (Object.hasOwn(options.settings.shape, "enabled")) throw invalid("enabled is an implicit option and cannot be declared");
  const schema = object({ ...(options.settings.shape as AnyShape), enabled: enabledOption() } as AnyShape & EnabledShape);
  const keyList = (field: "after" | "enables", entries: readonly unknown[] = []): readonly string[] => {
    if (!Array.isArray(entries)) throw invalid(`${field} must be a list of feature keys`);
    for (const entry of entries) if (typeof entry !== "string" || !FEATURE_KEY.test(entry)) throw invalid(`${field} has an invalid key ${JSON.stringify(entry)}`);
    return Object.freeze([...(entries as string[])]);
  };
  if (input.requires !== undefined && !Array.isArray(input.requires)) throw invalid("requires must be a list of feature keys");
  const requires = Object.freeze(
    (input.requires ?? []).map((entry) => {
      const requirement = typeof entry === "string" ? { name: entry } : entry;
      if (typeof requirement?.name !== "string" || !FEATURE_KEY.test(requirement.name)) throw invalid(`requires has an invalid key ${JSON.stringify(entry)}`);
      return Object.freeze(requirement.hint ? { name: requirement.name, hint: requirement.hint } : { name: requirement.name });
    }),
  );
  const definition: FeatureDefinition<S> = {
    key,
    schema,
    ...(input.docs ? { docs: Object.freeze({ ...input.docs }) } : {}),
    enabledByDefault: input.enabledByDefault ?? false,
    requires,
    after: keyList("after", input.after),
    enables: keyList("enables", input.enables),
    options() {
      const resolved = resolvedOptions.get(definition as FeatureDefinition);
      if (!resolved) throw new Error(`${key} is not enabled; add ${key}: {} to quickservice.config.ts`);
      return resolved as FeatureOptions<S>;
    },
  };
  return Object.freeze(definition);
}

const natives = new Map<string, FeatureDefinition>();

/** Registers a feature that lives in the core as a native; its key becomes a top-level config key. */
export function registerNative<S extends AnyOptionSchema>(definition: FeatureDefinition<S>): FeatureDefinition<S> {
  if (natives.has(definition.key)) throw new Error(`Native ${definition.key} is registered twice`);
  natives.set(definition.key, definition as unknown as FeatureDefinition);
  return definition;
}

/** The registered natives, in registration order. */
export function registeredNatives(): FeatureDefinition[] {
  return [...natives.values()];
}

/** Removes a registered native; for tests that register their own. */
export function unregisterNative(key: string): void {
  natives.delete(key);
}

export interface ResolvedFeatures {
  /** The enabled features, each after the natives it requires, enables or follows. */
  features: ResolvedFeature[];
  disabledFeatures: string[];
  /** The natives enabled through `enables`, with the features that listed them. */
  enabledBy: Record<string, string[]>;
}

type ConfigValue = { state: "off" } | { state: "absent" } | { state: "on"; input: unknown };

/**
 * Resolves every registered feature: a feature is enabled by its key set to an object or `true`, by
 * `enabledByDefault`, or by an enabled feature that lists it in `enables`, and disabled by `false`, by no key, or by
 * `enabled: false`. Requirements are checked, and the enabled features are ordered after what they depend on.
 */
export function resolveFeatures(config: Record<string, unknown>, definitions: readonly FeatureDefinition[] = registeredNatives()): ResolvedFeatures {
  const problems: string[] = [];
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const values = new Map<string, ConfigValue>();
  for (const definition of definitions) {
    const value = config[definition.key];
    if (value === false) values.set(definition.key, { state: "off" });
    else if (value === undefined) values.set(definition.key, definition.enabledByDefault ? { state: "on", input: {} } : { state: "absent" });
    else if (value === true) values.set(definition.key, { state: "on", input: {} });
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) values.set(definition.key, { state: "on", input: value });
    else {
      problems.push(`Invalid ${definition.key}: expected an options object, true or false, got ${JSON.stringify(value)}`);
      values.set(definition.key, { state: "off" });
    }
  }

  const enabled = new Map<string, Record<string, unknown> & { enabled: boolean }>();
  /** Keys turned off by `false` or `enabled: false`, which nothing may turn on. */
  const off = new Set<string>();
  const resolveOne = (definition: FeatureDefinition, input: unknown) => {
    try {
      const options = resolveOptions(definition.schema, input, definition.key) as Record<string, unknown> & { enabled: boolean };
      if (options.enabled === false) off.add(definition.key);
      else enabled.set(definition.key, options);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
      off.add(definition.key);
    }
  };
  for (const definition of definitions) {
    const value = values.get(definition.key)!;
    if (value.state === "off") off.add(definition.key);
    else if (value.state === "on") resolveOne(definition, value.input);
  }

  // Features enabled through `enables` may enable others in turn.
  const enabledBy: Record<string, string[]> = {};
  const conflicts = new Set<string>();
  const pending = definitions.filter((definition) => enabled.has(definition.key));
  while (pending.length > 0) {
    const feature = pending.shift()!;
    for (const name of feature.enables) {
      const target = byKey.get(name);
      if (!target) {
        problems.push(`${feature.key} enables ${name}, which is not a native feature`);
        continue;
      }
      if (off.has(name)) {
        const line = `${feature.key} needs ${name}, but ${name} is false; remove ${name}: false or turn off ${feature.key}`;
        if (!conflicts.has(line)) problems.push(line);
        conflicts.add(line);
        continue;
      }
      if (config[name] !== undefined) continue;
      (enabledBy[name] ??= []).includes(feature.key) || enabledBy[name]!.push(feature.key);
      if (enabled.has(name)) continue;
      resolveOne(target, {});
      if (enabled.has(name)) pending.push(target);
    }
  }

  for (const definition of definitions) {
    if (!enabled.has(definition.key)) continue;
    for (const requirement of definition.requires) {
      if (!byKey.has(requirement.name)) {
        problems.push(`${definition.key} requires ${requirement.name}, which is not a native feature`);
      } else if (!enabled.has(requirement.name)) {
        const hint = requirement.hint ? ` (${requirement.hint})` : "";
        problems.push(`${definition.key} requires ${requirement.name}; add ${requirement.name}: {} to quickservice.config.ts${hint}`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));

  const ordered = orderFeatures(definitions.filter((definition) => enabled.has(definition.key)));
  for (const definition of definitions) {
    if (enabled.has(definition.key)) resolvedOptions.set(definition, enabled.get(definition.key)!);
    else resolvedOptions.delete(definition);
  }
  return {
    features: ordered.map((definition) => ({ key: definition.key, options: enabled.get(definition.key)!, definition, native: natives.get(definition.key) === definition })),
    disabledFeatures: definitions.filter((definition) => !enabled.has(definition.key)).map((definition) => definition.key),
    enabledBy,
  };
}

/** Orders features after the enabled features they require, enable or follow, keeping the given order otherwise. */
function orderFeatures(features: FeatureDefinition[]): FeatureDefinition[] {
  const keys = new Set(features.map((feature) => feature.key));
  const dependencies = new Map(
    features.map((feature) => [
      feature.key,
      [...new Set([...feature.requires.map((requirement) => requirement.name), ...feature.enables, ...feature.after])].filter((key) => keys.has(key) && key !== feature.key),
    ]),
  );
  const ordered: FeatureDefinition[] = [];
  const placed = new Set<string>();
  while (ordered.length < features.length) {
    const next = features.find((feature) => !placed.has(feature.key) && dependencies.get(feature.key)!.every((key) => placed.has(key)));
    if (!next) throw new ConfigError(`Feature dependency cycle: ${findCycle(features.filter((feature) => !placed.has(feature.key)), dependencies).join(" -> ")}`);
    ordered.push(next);
    placed.add(next.key);
  }
  return ordered;
}

function findCycle(remaining: FeatureDefinition[], dependencies: Map<string, string[]>): string[] {
  const left = new Set(remaining.map((feature) => feature.key));
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const at = path.indexOf(key);
    if (at >= 0) return [...path.slice(at), key];
    path.push(key);
    for (const next of dependencies.get(key)!) {
      if (!left.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    return undefined;
  };
  for (const feature of remaining) {
    const cycle = visit(feature.key);
    if (cycle) return cycle;
  }
  return [...left];
}

/** Logs the enabled features in order, with the features that enabled each native turned on through `enables`. */
export function logEnabledFeatures(config: { features: readonly ResolvedFeature[]; enabledBy: Readonly<Record<string, string[]>>; logger?: Logger }): void {
  safeLog(config.logger ?? jsonLogger, "info", {
    timestamp: new Date().toISOString(),
    message: "features.enabled",
    features: config.features.map(({ key }) => (config.enabledBy[key] ? { key, enabledBy: config.enabledBy[key] } : { key })),
  });
}
