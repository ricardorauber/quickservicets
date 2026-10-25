import {
  ConfigError,
  parseOptionString,
  registeredNatives,
  suggestion,
  type FeatureTag,
  type FeatureTagTarget,
  type ParsedTag,
  type ParsedTags,
  type ResolvedFeature,
} from "@quickservice/core";
import { BuildError } from "../errors.ts";
import type { DocTag } from "./jsdoc.ts";

/** A tag of an enabled feature, with what parsing its options needs. */
export interface FeatureTagEntry {
  name: string;
  /** The key of the feature that defines it. */
  key: string;
  tag: FeatureTag;
  feature: ResolvedFeature;
}

/** The tags of the enabled features, and the tags of registered natives that are not enabled. */
export interface FeatureTagSet {
  tags: Map<string, FeatureTagEntry>;
  /** Tag name to the key of the disabled native that defines it. */
  disabled: Map<string, string>;
}

const empty = (): FeatureTagSet => ({ tags: new Map(), disabled: new Map() });
let active: FeatureTagSet = empty();

/** The feature tags the parsers read: the ones of the build in progress. */
export function activeFeatureTags(): FeatureTagSet {
  return active;
}

/**
 * Registers the tags of the enabled features for the parsers until the returned function restores the previous ones,
 * failing when a tag has the name of a built-in tag or of another feature's tag.
 */
export function useFeatureTags(features: readonly ResolvedFeature[], builtIn: (name: string) => string | undefined): () => void {
  const set = empty();
  for (const feature of features) {
    for (const [name, tag] of Object.entries(feature.definition.tags ?? {})) {
      const builtInOwner = builtIn(name);
      if (builtInOwner) throw new BuildError(`Tag @${name} of ${feature.key} conflicts with ${builtInOwner}`);
      const previous = set.tags.get(name);
      if (previous) throw new BuildError(`Tag @${name} of ${feature.key} conflicts with ${previous.key}`);
      set.tags.set(name, { name, key: feature.key, tag, feature });
    }
  }
  const enabled = new Set(features.map((feature) => feature.key));
  for (const native of registeredNatives()) {
    if (enabled.has(native.key)) continue;
    for (const name of Object.keys(native.tags ?? {})) if (!set.tags.has(name)) set.disabled.set(name, native.key);
  }
  const previous = active;
  active = set;
  return () => {
    active = previous;
  };
}

/** Fails when a feature tag has the name of one of the project's hooks. */
export function assertNoHookConflicts(set: FeatureTagSet, hooks: ReadonlyMap<string, { file: string }>): void {
  for (const [name, entry] of set.tags) {
    const hook = hooks.get(name);
    if (hook) throw new BuildError(`Tag @${name} of ${entry.key} conflicts with the hook ${hook.file}`);
  }
}

const TARGET_NAMES: Record<FeatureTagTarget, string> = { entity: "entities", field: "fields", endpoint: "endpoints" };
const PAIR = /^([A-Za-z_$][\w$]*)=("((?:[^"\\]|\\.)*)"|[^\s"]*)(?:\s+|$)/;

/** Parses `@name`, `@name off` or `@name key=value key2="a quoted value"` written on a target, or throws the reason. */
function parseTagText(entry: FeatureTagEntry, text: string): ParsedTag {
  if (text === "") return { on: true, options: {} };
  if (text === "off") return { on: false, options: {} };
  const allowed = entry.tag.options ?? [];
  const shape = entry.feature.definition.schema.settings.shape!;
  const options: Record<string, unknown> = {};
  let rest = text;
  while (rest !== "") {
    const match = PAIR.exec(rest);
    if (!match) throw new Error(`expects off or key=value pairs, got "${rest}"`);
    rest = rest.slice(match[0].length);
    const [, key = "", , quoted] = match;
    const raw = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : match[2]!;
    if (!allowed.includes(key)) {
      throw new Error(allowed.length === 0 ? `takes no options, got ${key}` : `unknown option ${key}${suggestion(key, allowed)}`);
    }
    try {
      options[key] = parseOptionString(shape[key]!, raw, key);
    } catch (error) {
      if (error instanceof ConfigError) throw new Error(error.message.replace(/^Invalid /, ""));
      throw error;
    }
  }
  return { on: true, options };
}

/**
 * Reads a feature tag written on a target into `tags`, or returns false when no enabled feature defines the tag. Fails
 * with `<file>: invalid @<name>: <reason>` when the tag does not apply to the target or its options are invalid.
 */
export function applyFeatureTag(tags: ParsedTags | undefined, tag: DocTag, target: FeatureTagTarget, file: string): ParsedTags | false {
  const entry = active.tags.get(tag.name);
  if (!entry) return false;
  const fail = (reason: string) => new BuildError(`${file}: invalid @${tag.name}: ${reason}`);
  if (!entry.tag.on.includes(target)) throw fail(`applies only to ${entry.tag.on.map((on) => TARGET_NAMES[on]).join(" and ")}, not to ${TARGET_NAMES[target]}`);
  const result = { ...tags };
  if (Object.hasOwn(result, tag.name)) throw fail("is written more than once");
  try {
    result[tag.name] = parseTagText(entry, tag.text);
  } catch (error) {
    throw fail((error as Error).message);
  }
  return result;
}

/** The message for a tag no built-in, hook or enabled feature defines. */
export function unknownTagMessage(file: string, name: string): string {
  const native = active.disabled.get(name);
  if (native) return `${file}: @${name} needs ${native}, which is not enabled; add ${native}: {} to quickservice.config.ts`;
  return `${file}: unknown tag @${name}: no hook or feature defines it`;
}
