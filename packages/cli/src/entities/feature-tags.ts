import {
  ConfigError,
  parseOptionString,
  registeredNatives,
  scopedOptionSchema,
  suggestion,
  type FeatureTag,
  type FeatureTagTarget,
  type ParsedTag,
  type ParsedTags,
  type ResolvedFeature,
} from "@quickservicets/core";
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
/** A bare first value: a quoted text, or a word without `=`. */
const BARE = /^(?:"((?:[^"\\]|\\.)*)"|([^\s"=]+))(?:\s+|$)/;

const unquote = (quoted: string) => quoted.replace(/\\(.)/g, "$1");

/** How a target wrote each of its feature tags: whether a plain `@<tag>` line was read, and the options set on dotted lines. */
const written = new WeakMap<ParsedTag, { plain: boolean; dotted: string[] }>();

/** Parses one option value of a tag the way `key=value` does, or throws the reason. */
function parseOption(entry: FeatureTagEntry, key: string, raw: string): unknown {
  const shape = scopedOptionSchema(entry.feature.definition.schema, entry.tag.scope)!.settings.shape!;
  try {
    return parseOptionString(shape[key]!, raw, key);
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(error.message.replace(/^Invalid /, ""));
    throw error;
  }
}

/**
 * Parses `@name`, `@name on`, `@name off`, `@name <shorthand value>` or `@name key=value key2="a quoted value"` written on a
 * target, or throws the reason. Keys are relative to the tag's scope and parsed with the scoped object's schema.
 */
function parseTagText(entry: FeatureTagEntry, text: string, target: FeatureTagTarget): ParsedTag {
  // `@name on` says explicitly what a bare `@name` says, like a field kept by `@history on`.
  if (text === "" || text === "on") return { on: true, options: {} };
  if (text === "off") return { on: false, options: {} };
  const allowed = (target === "field" ? entry.tag.fieldOptions : undefined) ?? entry.tag.options ?? [];
  const options: Record<string, unknown> = {};
  const parse = (key: string, raw: string) => {
    if (key === entry.tag.shorthand && Object.hasOwn(options, key)) throw new Error(`${key} is given twice`);
    options[key] = parseOption(entry, key, raw);
  };
  let rest = text;
  const bare = entry.tag.shorthand !== undefined && allowed.includes(entry.tag.shorthand) ? BARE.exec(rest) : null;
  if (bare) {
    rest = rest.slice(bare[0].length);
    parse(entry.tag.shorthand!, bare[1] !== undefined ? unquote(bare[1]) : bare[2]!);
  }
  while (rest !== "") {
    const match = PAIR.exec(rest);
    if (!match) throw new Error(`expects off or key=value pairs, got "${rest}"`);
    rest = rest.slice(match[0].length);
    const [, key = "", , quoted] = match;
    const raw = quoted !== undefined ? unquote(quoted) : match[2]!;
    if (!allowed.includes(key)) {
      throw new Error(allowed.length === 0 ? `takes no options, got ${key}` : `unknown option ${key}${suggestion(key, allowed)}`);
    }
    parse(key, raw);
  }
  return { on: true, options };
}

/**
 * Reads a feature tag written on a target into `tags`, or returns false when no enabled feature defines the tag. Fails
 * with `<file>: invalid @<name>: <reason>` when the tag does not apply to the target or its options are invalid. A
 * dotted line, `@<tag>.<option> <value>`, sets one option of `@<tag>`, and merges with the target's other lines of it.
 */
export function applyFeatureTag(tags: ParsedTags | undefined, tag: DocTag, target: FeatureTagTarget, file: string): ParsedTags | false {
  const dot = tag.name.indexOf(".");
  const name = dot < 0 ? tag.name : tag.name.slice(0, dot);
  const option = dot < 0 ? undefined : tag.name.slice(dot + 1);
  const entry = active.tags.get(name);
  if (!entry) {
    if (option !== undefined) throw new BuildError(unknownTagMessage(file, name));
    return false;
  }
  const fail = (reason: string) => new BuildError(`${file}: invalid @${name}: ${reason}`);
  if (!entry.tag.on.includes(target)) throw fail(`applies only to ${entry.tag.on.map((on) => TARGET_NAMES[on]).join(" and ")}, not to ${TARGET_NAMES[target]}`);
  const result = { ...tags };
  const existing = Object.hasOwn(result, name) ? result[name]! : undefined;
  const history = existing ? (written.get(existing) ?? { plain: true, dotted: [] }) : { plain: false, dotted: [] as string[] };
  let parsed: ParsedTag;
  if (option === undefined) {
    if (history.plain) throw fail("is written more than once");
    let plain: ParsedTag;
    try {
      plain = parseTagText(entry, tag.text, target);
    } catch (error) {
      throw fail((error as Error).message);
    }
    if (existing) {
      if (!plain.on) throw new BuildError(`${file}: @${name} off cannot be combined with @${name}.${history.dotted[0]}`);
      for (const key of Object.keys(plain.options)) if (Object.hasOwn(existing.options, key)) throw new BuildError(`${file}: @${name}.${key} is set twice`);
    }
    parsed = existing ? { on: true, options: { ...existing.options, ...plain.options } } : plain;
    written.set(parsed, { plain: true, dotted: history.dotted });
  } else {
    if (existing && !existing.on) throw new BuildError(`${file}: @${name} off cannot be combined with @${name}.${option}`);
    const allowed = (target === "field" ? entry.tag.fieldOptions : undefined) ?? entry.tag.options ?? [];
    if (!allowed.includes(option)) throw fail(allowed.length === 0 ? `takes no options, got ${option}` : `unknown option ${option}${suggestion(option, allowed)}`);
    if (existing && Object.hasOwn(existing.options, option)) throw new BuildError(`${file}: @${name}.${option} is set twice`);
    const shape = scopedOptionSchema(entry.feature.definition.schema, entry.tag.scope)!.settings.shape!;
    let value: unknown;
    if (tag.text === "") {
      if (shape[option]?.kind !== "boolean") throw new BuildError(`${file}: @${name}.${option} needs a value`);
      value = true;
    } else {
      try {
        value = parseOption(entry, option, tag.text);
      } catch (error) {
        throw fail((error as Error).message);
      }
    }
    parsed = { on: true, options: { ...existing?.options, [option]: value } };
    written.set(parsed, { plain: history.plain, dotted: [...history.dotted, option] });
  }
  result[name] = parsed;
  const problem = parsed.on && entry.tag.check ? entry.tag.check(parsed.options, entry.feature.options, target) : undefined;
  if (problem) throw fail(problem);
  return result;
}

/** The message for a tag no built-in, hook or enabled feature defines. */
export function unknownTagMessage(file: string, name: string): string {
  const native = active.disabled.get(name);
  if (native) return `${file}: @${name} needs ${native}, which is not enabled; add ${native}: {} to quickservicets.config.ts`;
  return `${file}: unknown tag @${name}: no hook or feature defines it`;
}
