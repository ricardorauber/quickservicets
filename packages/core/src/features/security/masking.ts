import type { AnyOptionSchema, EntityModel, LogMasker, ParsedTags } from "../public.ts";

/** What replaces a secret value. */
export const SECRET = "[secret]";
/** What replaces the value of a field tagged `@sensitive`. */
export const SENSITIVE = "[sensitive]";

/** The default keys: a property whose name contains one of them (ignoring case, `-` and `_`) holds a secret. */
export const DEFAULT_MASKED_KEYS = ["password", "passwd", "secret", "token", "apikey", "authorization", "cookie", "setcookie", "privatekey", "clientsecret", "signature", "creditcard", "cardnumber", "cvv"];

/** The shortest secret value masked inside strings; shorter ones would mask ordinary words. */
export const MIN_SECRET_LENGTH = 8;

/** The deepest level of objects and arrays `maskEntry` walks. */
export const MAX_DEPTH = 8;

/** What is masked: property names containing `keys`, properties named like `@sensitive` fields, and secret values. */
export interface MaskingRules {
  keys: readonly string[];
  /** The names of the model's fields tagged `@sensitive`. */
  sensitive?: Iterable<string>;
  /** Known secret values (secret variables and options); those shorter than 8 characters are ignored. */
  secrets?: Iterable<string>;
}

interface Compiled {
  keys: string[];
  sensitive: Set<string>;
  secrets: string[];
  /** Whether a property name matches a key, cached per name. */
  names: Map<string, boolean>;
}

const compiledRules = new WeakMap<MaskingRules, Compiled>();

const normalized = (name: string) => name.toLowerCase().replace(/[-_]/g, "");

function compile(rules: MaskingRules): Compiled {
  let compiled = compiledRules.get(rules);
  if (!compiled) {
    compiled = {
      keys: rules.keys.map(normalized).filter((key) => key !== ""),
      sensitive: new Set(rules.sensitive ?? []),
      // Longer values first, so a secret containing another is masked whole.
      secrets: [...new Set(rules.secrets ?? [])].filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length),
      names: new Map(),
    };
    compiledRules.set(rules, compiled);
  }
  return compiled;
}

function secretName(compiled: Compiled, name: string): boolean {
  let found = compiled.names.get(name);
  if (found === undefined) {
    const lower = normalized(name);
    found = compiled.keys.some((key) => lower.includes(key));
    if (compiled.names.size < 10_000) compiled.names.set(name, found);
  }
  return found;
}

function maskString(compiled: Compiled, text: string): string {
  let masked = text;
  for (const secret of compiled.secrets) if (masked.includes(secret)) masked = masked.replaceAll(secret, SECRET);
  return masked;
}

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function walk(compiled: Compiled, value: unknown, depth: number): unknown {
  if (typeof value === "string") return compiled.secrets.length > 0 ? maskString(compiled, value) : value;
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const item = walk(compiled, value[index], depth + 1);
      if (item !== value[index]) (copy ??= [...value])[index] = item;
    }
    return copy ?? value;
  }
  // Dates, errors and other instances are left as they are.
  if (!isPlainObject(value)) return value;
  const source = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const name of Object.keys(source)) {
    const current = source[name];
    const next =
      current === undefined || current === null
        ? current
        : secretName(compiled, name)
          ? SECRET
          : compiled.sensitive.has(name)
            ? SENSITIVE
            : walk(compiled, current, depth + 1);
    if (next !== current) (copy ??= { ...source })[name] = next;
  }
  return copy ?? value;
}

/**
 * A copy of a log entry in which the value of every property whose name matches a key is `[secret]`, the value of
 * every property named like a `@sensitive` field is `[sensitive]`, and every known secret value inside a string is
 * `[secret]`. It walks plain objects and arrays up to depth 8, leaves dates and other instances intact, never changes
 * its input and returns the input itself when nothing changed.
 */
export function maskEntry<T>(value: T, rules: MaskingRules): T {
  return walk(compile(rules), value, 0) as T;
}

/** Text with every known secret value replaced by `[secret]`. */
export function maskText(text: string, rules: MaskingRules): string {
  return maskString(compile(rules), text);
}

/**
 * A URL with `[secret]` for its user information and for the values of query parameters whose names match a key,
 * keeping the rest as written.
 */
export function maskUrl(url: string, rules: MaskingRules): string {
  const compiled = compile(rules);
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  let rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = rest.indexOf("?");
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : undefined;
  rest = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*@)/i.exec(rest);
  if (authority) rest = `${authority[1]}${SECRET}@${rest.slice(authority[0].length)}`;
  const masked =
    query === undefined
      ? undefined
      : query
          .split("&")
          .map((pair) => {
            const at = pair.indexOf("=");
            const name = at >= 0 ? pair.slice(0, at) : pair;
            let decoded = name;
            try {
              decoded = decodeURIComponent(name.replace(/\+/g, " "));
            } catch {
              // An invalid escape is matched as written.
            }
            return at >= 0 && secretName(compiled, decoded) ? `${name}=${SECRET}` : pair;
          })
          .join("&");
  return `${rest}${masked === undefined ? "" : `?${masked}`}${hash}`;
}

/** The masker the native gives the service: entries through `maskEntry`, stack texts through `maskText`. */
export function masker(rules: MaskingRules): LogMasker {
  return { entry: (value) => maskEntry(value, rules), text: (text) => maskText(text, rules) };
}

/** The values of the `secret()` options in a feature's resolved options. */
export function secretOptionValues(schema: AnyOptionSchema, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (schema.kind === "secret") return typeof value === "string" ? [value] : [];
  if ((schema.kind === "object" || schema.kind === "toggle") && typeof value === "object") {
    return Object.entries(schema.settings.shape!).flatMap(([key, child]) => secretOptionValues(child, (value as Record<string, unknown>)[key]));
  }
  if (schema.kind === "record" && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((entry) => secretOptionValues(schema.settings.item!, entry));
  if (schema.kind === "list" && Array.isArray(value)) return value.flatMap((entry) => secretOptionValues(schema.settings.item!, entry));
  return [];
}

/** The names of the fields tagged `@sensitive` in the model, nested fields included. */
export function sensitiveFieldNames(models: readonly EntityModel[]): Set<string> {
  const names = new Set<string>();
  const visit = (fields: readonly { name: string; tags?: ParsedTags; fields?: readonly unknown[] }[] | undefined) => {
    for (const field of fields ?? []) {
      if (field.tags?.sensitive?.on) names.add(field.name);
      visit(field.fields as never);
    }
  };
  for (const model of models) visit(model.fields as never);
  return names;
}
