import { ConfigError } from "./config-error.ts";
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
  const definition: FeatureDefinition<S> = {
    key,
    schema,
    ...(input.docs ? { docs: Object.freeze({ ...input.docs }) } : {}),
    enabledByDefault: input.enabledByDefault ?? false,
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
  features: ResolvedFeature[];
  disabledFeatures: string[];
}

/**
 * Resolves the options of every enabled feature under its key: a native is enabled by its key set to an object or
 * `true`, or by `enabledByDefault`, and disabled by `false`, by no key, or by `enabled: false`.
 */
export function resolveFeatures(config: Record<string, unknown>): ResolvedFeatures {
  const features: ResolvedFeature[] = [];
  const disabledFeatures: string[] = [];
  const problems: string[] = [];
  for (const definition of natives.values()) {
    const value = config[definition.key];
    const disable = () => {
      disabledFeatures.push(definition.key);
      resolvedOptions.delete(definition);
    };
    if (value === false || (value === undefined && !definition.enabledByDefault)) {
      disable();
      continue;
    }
    if (value !== undefined && value !== true && (typeof value !== "object" || value === null || Array.isArray(value))) {
      problems.push(`Invalid ${definition.key}: expected an options object, true or false, got ${JSON.stringify(value)}`);
      disable();
      continue;
    }
    let options: Record<string, unknown> & { enabled: boolean };
    try {
      options = resolveOptions(definition.schema, value === undefined || value === true ? {} : value, definition.key) as typeof options;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
      disable();
      continue;
    }
    if (options.enabled === false) {
      disable();
      continue;
    }
    resolvedOptions.set(definition, options);
    features.push({ key: definition.key, options, definition, native: true });
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
  return { features, disabledFeatures };
}
