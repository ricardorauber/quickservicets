import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config-error.ts";
import { featureVariables, optionLeaves } from "./environment.ts";
import { maskSecrets } from "./secrets.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import { tagsOf, type OptionsTarget } from "./feature-targets.ts";
import type { FeatureSetupContext } from "./lifecycle.ts";
import type { Middleware } from "./middleware.ts";
import type { ServiceRequest } from "./hooks.ts";
import type { FeatureOpenApiContext, OpenApiDoc } from "./openapi.ts";
import { isCommandDefinition, type CommandDefinition } from "./commands.ts";
import type { FeatureBuildContext } from "./build-steps.ts";
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
  /** Environment variables the feature needs, read and checked at startup with the project's (see `env`). */
  env?: Readonly<Record<string, AnyOptionSchema>>;
  /**
   * Entities the feature adds to the project's model: a folder of entity files relative to the feature's folder
   * (`"./entities"`), a list of `entityModel(...)` objects, or a function of the project's models and the feature's
   * options returning models.
   */
  entities?: FeatureEntities<FeatureOptions<S>>;
  /** A folder of endpoint files relative to the feature's folder (`"./endpoints"`), routed like the project's `endpoints/`. */
  endpoints?: string;
  /** A folder of hook files relative to the feature's folder (`"./hooks"`), named like the project's `hooks/`. */
  hooks?: string;
  /** A folder of job files relative to the feature's folder (`"./jobs"`); each job is named `<key>/<path>`. */
  jobs?: string;
  /**
   * JSDoc tags the feature adds, by name, so one entity, field or endpoint can turn the feature off (`@<name> off`) or
   * set its options (`@<name> key=value`).
   */
  tags?: Readonly<Record<string, FeatureTag>>;
  /**
   * Convention folders the feature gives the project, by name: the build scans `<dir>/**\/*.ts` in the project and in
   * the feature's folder into the `featureFolders` registry, keyed by each file's path without extension.
   */
  folders?: Readonly<Record<string, FeatureFolder>>;
  /** Project-relative paths `quickservice dev` watches for this feature, besides its folders. */
  watch?: readonly string[];
  /**
   * Runs in each worker process before the database connects, in feature order; registers lifecycle callbacks and
   * runtime routes through `ctx.app`.
   */
  setup?: FeatureSetup<FeatureOptions<S>>;
  /** Middlewares of the `request`, `handler` and `error` stages, run in feature order, then by `order`. */
  middleware?: readonly Middleware[];
  /**
   * Properties added to every request, by name, each computed on first read and kept for the request; declare their
   * types in `RequestExtensions`.
   */
  request?: Readonly<Record<string, (req: ServiceRequest) => unknown>>;
  /**
   * Changes the generated OpenAPI document at build time, in place or by returning a new one; runs in feature order
   * before the project's `docs.openapi`.
   */
  openapi?: FeatureOpenApi<FeatureOptions<S>>;
  /** `quickservice <name>` commands, built with `defineCommand`, listed under the feature's key in the help. */
  commands?: readonly CommandDefinition[];
  /**
   * Produces files at build time into `.generated/<key>/`, after the rest of `.generated` is written, in feature
   * order; `quickservice dev` runs it again when its folders or `watch` paths change.
   */
  build?: FeatureBuild<FeatureOptions<S>>;
}

/** The `build` field of a feature definition. */
export type FeatureBuild<O = Record<string, unknown>> = Bivariant<(ctx: FeatureBuildContext<O>) => void | Promise<void>>;

/** The `openapi` field of a feature definition. */
export type FeatureOpenApi<O = Record<string, unknown>> = Bivariant<(doc: OpenApiDoc, context: FeatureOpenApiContext<O>) => OpenApiDoc | void | undefined>;

/** The `setup` field of a feature definition. */
export type FeatureSetup<O = Record<string, unknown>> = Bivariant<(ctx: FeatureSetupContext<O>) => void | Promise<void>>;

/** A convention folder a feature declares. */
export interface FeatureFolder {
  /** The project-relative folder, like `queues`. */
  dir: string;
  /** Checks a file's default export: returns true, or the reason it is rejected. */
  check?: (value: unknown, file: string) => true | string;
  /** One sentence on what the folder holds. */
  description: string;
}

/** Where a feature tag may be written. */
export type FeatureTagTarget = "entity" | "field" | "endpoint";

/** A JSDoc tag of a feature. */
export interface FeatureTag {
  /** The targets the tag may be written on. */
  on: readonly FeatureTagTarget[];
  /**
   * The feature's option keys the tag may set (default: none, which makes the tag a flag); with `scope`, keys of the
   * scoped object.
   */
  options?: readonly string[];
  /**
   * The option a bare first value sets: with `shorthand: "limit"`, `@rateLimit 10/min by=user` equals
   * `@rateLimit limit=10/min by=user`. Must be one of `options`.
   */
  shorthand?: string;
  /**
   * A dot path to a nested object of the feature's options (`"rateLimit"`): the tag's options are then keys of that
   * object, and `optionsFor` merges them into it only.
   */
  scope?: string;
  /** One sentence on what the tag does, for the reference. */
  description: string;
  /** A short sample of the tag in use, for the reference. */
  example: string;
}

/** The resolved options of a feature for one target, with whether the target turns the feature on or off by its tag. */
export type TargetOptions<O> = O & {
  /** True when the target has the feature's tag, false with `@<name> off`, undefined without the tag. */
  on: boolean | undefined;
};

/** What a function form of `entities` receives. */
export interface FeatureEntitiesContext<O = Record<string, unknown>> {
  /** The project's entities and the entities of feature folders, parsed. */
  models: readonly EntityModel[];
  /** The feature's resolved options. */
  options: O;
}

/** The `entities` field of a feature definition. */
export type FeatureEntities<O = Record<string, unknown>> = string | readonly EntityModel[] | Bivariant<(context: FeatureEntitiesContext<O>) => EntityModel[]>;

/** A function type whose parameter is checked bivariantly, so a definition typed with its options stays assignable to `FeatureDefinition`. */
type Bivariant<F extends (...args: never[]) => unknown> = { method(...args: Parameters<F>): ReturnType<F> }["method"];

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
  /** The environment variables the feature declares. */
  readonly env?: Readonly<Record<string, AnyOptionSchema>>;
  /** The entities the feature contributes. */
  readonly entities?: FeatureEntities<FeatureOptions<S>>;
  /** The feature's folder of endpoint files, relative to its folder. */
  readonly endpoints?: string;
  /** The feature's folder of hook files, relative to its folder. */
  readonly hooks?: string;
  /** The feature's folder of job files, relative to its folder. */
  readonly jobs?: string;
  /** The feature's JSDoc tags, by name. */
  readonly tags?: Readonly<Record<string, FeatureTag>>;
  /** The convention folders the feature declares, by name. */
  readonly folders?: Readonly<Record<string, FeatureFolder>>;
  /** Project-relative paths `quickservice dev` watches for this feature. */
  readonly watch?: readonly string[];
  /** The feature's setup, run in each worker process before the database connects. */
  readonly setup?: FeatureSetup<FeatureOptions<S>>;
  /** The feature's middlewares. */
  readonly middleware?: readonly Middleware[];
  /** The request properties the feature adds, by name. */
  readonly request?: Readonly<Record<string, (req: ServiceRequest) => unknown>>;
  /** Changes the generated OpenAPI document at build time. */
  readonly openapi?: FeatureOpenApi<FeatureOptions<S>>;
  /** The feature's CLI commands. */
  readonly commands?: readonly CommandDefinition[];
  /** The feature's build step. */
  readonly build?: FeatureBuild<FeatureOptions<S>>;
  /**
   * The feature's resolved options, once a configuration enabling it has been resolved in this process; throws
   * otherwise. The feature's own code reads its typed options here instead of receiving the config.
   */
  options(): FeatureOptions<S>;
  /**
   * The feature's options for one entity (by key or model), field (`{ entity, field }`) or endpoint
   * (`{ method, path }`): the resolved options with the options its tags set on top, which win over the config and
   * environment for that target.
   */
  optionsFor(target: OptionsTarget): TargetOptions<FeatureOptions<S>>;
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
  /** Written in the project, in `features/<key>/index.ts`. */
  project: boolean;
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
  // Each option is set by one environment variable, so two options may not share a name.
  featureVariables(key, schema);
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
    ...(input.env ? { env: Object.freeze({ ...input.env }) } : {}),
    ...(input.entities !== undefined ? { entities: entitiesField(input.entities, invalid) } : {}),
    ...folderFields(input, invalid),
    ...(input.tags !== undefined ? { tags: tagsField(key, input.tags, schema, invalid) } : {}),
    ...(input.folders !== undefined ? { folders: foldersField(input.folders, invalid) } : {}),
    ...(input.watch !== undefined ? { watch: watchField(input.watch, invalid) } : {}),
    ...(input.setup !== undefined ? { setup: functionField(input.setup, "setup", invalid) } : {}),
    ...(input.middleware !== undefined ? { middleware: middlewareField(input.middleware, invalid) } : {}),
    ...(input.request !== undefined ? { request: requestField(input.request, invalid) } : {}),
    ...(input.openapi !== undefined ? { openapi: functionField(input.openapi, "openapi", invalid) } : {}),
    ...(input.commands !== undefined ? { commands: commandsField(input.commands, invalid) } : {}),
    ...(input.build !== undefined ? { build: functionField(input.build, "build", invalid) } : {}),
    options() {
      const resolved = resolvedOptions.get(definition as FeatureDefinition);
      if (!resolved) throw new Error(`${key} is not enabled; add ${key}: {} to quickservice.config.ts`);
      return resolved as FeatureOptions<S>;
    },
    optionsFor(target) {
      return optionsForTarget(definition.options() as Record<string, unknown>, schema, definition.tags, tagsOf(target)) as TargetOptions<FeatureOptions<S>>;
    },
  };
  Object.defineProperty(definition, FEATURE_BRAND, { value: true });
  return Object.freeze(definition);
}

/** The contribution folders a definition declares, each a path relative to the feature's folder. */
function folderFields(input: { endpoints?: unknown; hooks?: unknown; jobs?: unknown }, invalid: (reason: string) => Error): { endpoints?: string; hooks?: string; jobs?: string } {
  const fields: { endpoints?: string; hooks?: string; jobs?: string } = {};
  for (const name of ["endpoints", "hooks", "jobs"] as const) {
    const value = input[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") throw invalid(`${name} must be a folder relative to the feature's folder`);
    fields[name] = value;
  }
  return fields;
}

const FOLDER_NAME = /^[a-z][a-zA-Z0-9-]*$/;

function foldersField(folders: Readonly<Record<string, FeatureFolder>>, invalid: (reason: string) => Error): Readonly<Record<string, FeatureFolder>> {
  if (typeof folders !== "object" || folders === null || Array.isArray(folders)) throw invalid("folders must map folder names to folder definitions");
  const checked: Record<string, FeatureFolder> = {};
  for (const [name, folder] of Object.entries(folders)) {
    if (!FOLDER_NAME.test(name)) throw invalid(`folder ${name}: names must match ^[a-z][a-zA-Z0-9-]*$`);
    if (typeof folder?.dir !== "string" || folder.dir === "" || folder.dir.startsWith("/") || folder.dir.split("/").includes("..")) {
      throw invalid(`folder ${name}: dir must be a folder inside the project`);
    }
    if (folder.check !== undefined && typeof folder.check !== "function") throw invalid(`folder ${name}: check must be a function`);
    checked[name] = Object.freeze({ ...folder, dir: folder.dir.replace(/^\.\//, "").replace(/\/+$/, "") });
  }
  return Object.freeze(checked);
}

function commandsField(commands: readonly CommandDefinition[], invalid: (reason: string) => Error): readonly CommandDefinition[] {
  if (!Array.isArray(commands) || !commands.every(isCommandDefinition)) throw invalid("commands must be a list of defineCommand(...) results");
  const names = commands.map((command) => command.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) throw invalid(`command ${repeated} is defined twice`);
  return Object.freeze([...commands]);
}

function middlewareField(middleware: readonly Middleware[], invalid: (reason: string) => Error): readonly Middleware[] {
  if (!Array.isArray(middleware)) throw invalid("middleware must be a list of middlewares");
  for (const entry of middleware) {
    if (!["request", "handler", "error"].includes(entry?.stage) || typeof entry.run !== "function") throw invalid('each middleware must be { stage: "request" | "handler" | "error", run, order? }');
  }
  return Object.freeze([...middleware]);
}

function requestField(request: Readonly<Record<string, (req: ServiceRequest) => unknown>>, invalid: (reason: string) => Error): Readonly<Record<string, (req: ServiceRequest) => unknown>> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw invalid("request must map property names to functions of the request");
  for (const [name, factory] of Object.entries(request)) if (typeof factory !== "function") throw invalid(`request property ${name} must be a function of the request`);
  return Object.freeze({ ...request });
}

function functionField<F>(value: F, name: string, invalid: (reason: string) => Error): F {
  if (typeof value !== "function") throw invalid(`${name} must be a function`);
  return value;
}

function watchField(paths: readonly string[], invalid: (reason: string) => Error): readonly string[] {
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path !== "")) throw invalid("watch must be a list of project paths");
  return Object.freeze([...paths]);
}

/** Folders the core owns; no feature may declare one. */
export const RESERVED_FOLDERS = ["entities", "endpoints", "hooks", "jobs", "migrations", "node_modules", ".generated", "features", "plugins"] as const;

/** Fails when an enabled feature declares a reserved folder, or two enabled features declare the same folder. */
export function assertFeatureFolders(features: readonly Pick<ResolvedFeature, "key" | "definition">[]): void {
  const owners = new Map<string, string>();
  const problems: string[] = [];
  for (const feature of features) {
    for (const folder of Object.values(feature.definition.folders ?? {})) {
      const top = folder.dir.split("/")[0]!;
      if ((RESERVED_FOLDERS as readonly string[]).includes(top)) problems.push(`Folder ${folder.dir} of ${feature.key} is reserved by the core`);
      const owner = owners.get(folder.dir);
      if (owner && owner !== feature.key) problems.push(`Folder ${folder.dir} is declared by both ${owner} and ${feature.key}`);
      owners.set(folder.dir, feature.key);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
}

const TAG_NAME = /^[a-z][a-zA-Z0-9]*$/;
const TAG_TARGETS: readonly FeatureTagTarget[] = ["entity", "field", "endpoint"];

/** Whether a schema node holds named options: an `object()`. */
function holdsOptions(schema: AnyOptionSchema | undefined): schema is AnyOptionSchema {
  return schema !== undefined && schema.kind === "object" && schema.settings.shape !== undefined;
}

/**
 * The nested options object a tag's `scope` path names inside a feature's schema, or the schema itself without a
 * scope; undefined when the path does not name an object of the schema.
 */
export function scopedOptionSchema(schema: AnyOptionSchema, scope: string | undefined): AnyOptionSchema | undefined {
  if (scope === undefined) return schema;
  let current: AnyOptionSchema | undefined = schema;
  for (const segment of scope.split(".")) {
    current = holdsOptions(current) && Object.hasOwn(current.settings.shape!, segment) ? current.settings.shape![segment] : undefined;
    if (!holdsOptions(current)) return undefined;
  }
  return current;
}

/**
 * Checks a definition's tags: names like hook names, known targets, option keys of the feature's schema (or of the
 * scoped object), and a shorthand among the tag's options.
 */
function tagsField(key: string, tags: Readonly<Record<string, FeatureTag>>, schema: AnyOptionSchema, invalid: (reason: string) => Error): Readonly<Record<string, FeatureTag>> {
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) throw invalid("tags must map tag names to tag definitions");
  const checked: Record<string, FeatureTag> = {};
  for (const [name, tag] of Object.entries(tags)) {
    if (!TAG_NAME.test(name)) throw invalid(`tag @${name}: names must match ^[a-z][a-zA-Z0-9]*$`);
    if (!Array.isArray(tag?.on) || tag.on.length === 0 || !tag.on.every((target) => TAG_TARGETS.includes(target))) {
      throw invalid(`tag @${name}: on must list entity, field or endpoint`);
    }
    const invalidTag = (reason: string) => new Error(`Invalid tag @${name} of ${key}: ${reason}`);
    if (tag.scope !== undefined && (typeof tag.scope !== "string" || tag.scope === "")) throw invalidTag("scope must be a dot path to an object of the options");
    const scoped = scopedOptionSchema(schema, tag.scope);
    if (!scoped) throw invalidTag(`scope ${tag.scope} is not an object of the options`);
    const shape = scoped.settings.shape!;
    for (const option of tag.options ?? []) {
      if (tag.scope === undefined) {
        if (option === "enabled" || !Object.hasOwn(shape, option)) throw invalid(`tag @${name}: ${option} is not an option of the feature`);
      } else if (!Object.hasOwn(shape, option)) {
        throw invalidTag(`${option} is not an option of ${tag.scope}`);
      }
    }
    if (tag.shorthand !== undefined && !(tag.options ?? []).includes(tag.shorthand)) throw invalidTag(`shorthand ${tag.shorthand} is not one of its options`);
    checked[name] = Object.freeze({ ...tag, on: Object.freeze([...tag.on]), ...(tag.options ? { options: Object.freeze([...tag.options]) } : {}) });
  }
  return Object.freeze(checked);
}

/** `value` with `patch` merged into the object at `path`, copying only the objects on the path. */
function mergeAt(value: Record<string, unknown>, path: readonly string[], patch: Record<string, unknown>): Record<string, unknown> {
  if (path.length === 0) return { ...value, ...patch };
  const [head, ...rest] = path as [string, ...string[]];
  const child = value[head];
  return { ...value, [head]: mergeAt(typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {}, rest, patch) };
}

/** Whether a scoped options object is a switchable section, which `@<tag> off` turns off for its target. */
function isSwitchable(schema: AnyOptionSchema): boolean {
  return schema.settings.shape?.enabled?.kind === "boolean";
}

/**
 * The options for one target: the feature's tags written on it applied over the resolved options, each into its
 * scoped object only; `off` on a switchable scope also sets its `enabled` to false.
 */
function optionsForTarget(
  options: Record<string, unknown>,
  schema: AnyOptionSchema,
  tags: Readonly<Record<string, FeatureTag>> | undefined,
  written: ReturnType<typeof tagsOf>,
): Record<string, unknown> {
  let on: boolean | undefined;
  let merged = options;
  for (const [name, definition] of Object.entries(tags ?? {})) {
    const tag = written?.[name];
    if (!tag) continue;
    if (definition.scope === undefined) merged = { ...merged, ...tag.options };
    else {
      const switchable = !tag.on && isSwitchable(scopedOptionSchema(schema, definition.scope)!);
      merged = mergeAt(merged, definition.scope.split("."), switchable ? { ...tag.options, enabled: false } : tag.options);
    }
    on = on === true || tag.on;
  }
  return { ...merged, on };
}

function entitiesField<O>(entities: FeatureEntities<O>, invalid: (reason: string) => Error): FeatureEntities<O> {
  if (typeof entities === "string" || typeof entities === "function") return entities;
  if (Array.isArray(entities)) return Object.freeze([...entities]);
  throw invalid("entities must be a folder, a list of entity models or a function");
}

/** Marks the values `defineFeature` returns, shared by every copy of the core loaded in a process. */
const FEATURE_BRAND = Symbol.for("quickservice.feature");

/** Whether a value is a feature definition returned by `defineFeature`. */
export function isFeatureDefinition(value: unknown): value is FeatureDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[FEATURE_BRAND] === true;
}

const natives = new Map<string, FeatureDefinition>();
/** The project's own features, by key; one with a native's key replaces that native. */
const projectFeatures = new Map<string, FeatureDefinition>();

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

/** A project feature as found in `features/<folder>/index.ts`: the folder name and the module's default export. */
export interface ProjectFeatureModule {
  folder: string;
  definition: unknown;
}

/**
 * Registers the project's features, replacing those registered before (one project per process at a time). Each
 * must default-export `defineFeature(...)` with the key of its folder; one with a native's key replaces that native.
 */
export function registerProjectFeatures(modules: readonly ProjectFeatureModule[]): void {
  const problems: string[] = [];
  const found = new Map<string, FeatureDefinition>();
  for (const { folder, definition } of modules) {
    const file = `features/${folder}/index.ts`;
    if (!isFeatureDefinition(definition)) problems.push(`${file}: must default-export defineFeature(...)`);
    else if (definition.key !== folder) problems.push(`${file}: the key is ${definition.key}, but the folder is ${folder}`);
    else found.set(folder, definition);
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
  projectFeatures.clear();
  for (const [key, definition] of found) projectFeatures.set(key, definition);
}

/** The project's registered features, by folder order. */
export function registeredProjectFeatures(): FeatureDefinition[] {
  return [...projectFeatures.values()];
}

/** The natives the project replaces with a feature of its own, by key. */
export function replacedNatives(): string[] {
  return [...natives.keys()].filter((key) => projectFeatures.has(key));
}

/** The features a configuration may enable: the natives the project does not replace, then the project's features. */
export function activeFeatureDefinitions(): FeatureDefinition[] {
  return [...[...natives.values()].filter((definition) => !projectFeatures.has(definition.key)), ...projectFeatures.values()];
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
export function resolveFeatures(config: Record<string, unknown>, definitions: readonly FeatureDefinition[] = activeFeatureDefinitions()): ResolvedFeatures {
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
    if (!enabled.has(definition.key)) {
      resolvedOptions.delete(definition);
      continue;
    }
    const options = enabled.get(definition.key)!;
    maskSecrets(options, secretPaths(definition.schema));
    resolvedOptions.set(definition, options);
  }
  for (const key of replacedNatives()) resolvedOptions.delete(natives.get(key)!);
  return {
    features: ordered.map((definition) => ({
      key: definition.key,
      options: enabled.get(definition.key)!,
      definition,
      native: natives.get(definition.key) === definition,
      project: projectFeatures.get(definition.key) === definition,
    })),
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

/** The folder of project features, at the project root. */
export const FEATURES_DIR = "features";

/** The folder holding each native feature's code, `packages/core/src/features/<key>/`. */
export const NATIVE_FEATURES_DIR = join(import.meta.dir, "features");

/** The folder of an enabled feature: `features/<key>/` for a project feature, the core's folder for a native. */
export function featureDir(feature: Pick<ResolvedFeature, "key" | "project">, projectRoot: string): string {
  return feature.project ? join(projectRoot, FEATURES_DIR, feature.key) : join(NATIVE_FEATURES_DIR, feature.key);
}

/** The folders of `features/` that hold an `index.ts`, sorted. */
export function projectFeatureFolders(projectRoot: string): string[] {
  const dir = join(projectRoot, FEATURES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

/** Imports and registers the project's `features/<key>/index.ts` files, before its config is resolved. */
export async function loadProjectFeatures(projectRoot: string): Promise<FeatureDefinition[]> {
  const modules: ProjectFeatureModule[] = [];
  for (const folder of projectFeatureFolders(projectRoot)) {
    const module = (await import(join(projectRoot, FEATURES_DIR, folder, "index.ts"))) as { default?: unknown };
    modules.push({ folder, definition: module.default });
  }
  registerProjectFeatures(modules);
  return registeredProjectFeatures();
}

/** The paths of a schema's secret options, relative to it. */
function secretPaths(schema: AnyOptionSchema): string[] {
  return optionLeaves(schema, "")
    .filter((leaf) => leaf.schema.kind === "secret")
    .map((leaf) => leaf.path.slice(1));
}
