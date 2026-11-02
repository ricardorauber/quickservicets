import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { maskSecrets } from "./secrets.ts";

const BRAND = Symbol.for("quickservicets.secretReference");

/** What a reference scheme looks like: a lowercase letter, then lowercase letters, digits and dashes. */
export const SECRET_SCHEME = /^[a-z][a-z0-9-]*$/;

/** Schemes of connection URLs, which a secret provider may never register, so a URL is never read as a reference. */
export const RESERVED_SECRET_SCHEMES: readonly string[] = ["http", "https", "postgres", "postgresql", "mysql", "mongodb", "mongodb+srv", "redis", "rediss", "amqp", "amqps", "ws", "wss"];

/** The built-in schemes of the `secrets` native. */
export const BUILT_IN_SECRET_SCHEMES: readonly string[] = ["env", "file"];

const REFERENCE_SYNTAX = "expected <scheme>://<path>[#<key>][?version=<version>]";

/**
 * A reference to a secret in a vault, like `vault://kv/db#url`: resolved at startup by the provider of its scheme, and
 * replaced by the secret's value in the resolved configuration.
 */
export class SecretReference {
  readonly scheme: string;
  readonly path: string;
  readonly key?: string;
  readonly version?: string;
  /** The reference as written. */
  readonly text: string;

  constructor(parts: { scheme: string; path: string; key?: string; version?: string; text: string }) {
    this.scheme = parts.scheme;
    this.path = parts.path;
    if (parts.key !== undefined) this.key = parts.key;
    if (parts.version !== undefined) this.version = parts.version;
    this.text = parts.text;
    Object.defineProperty(this, BRAND, { value: true });
    Object.freeze(this);
  }

  toString(): string {
    return this.text;
  }
}

/** Whether `value` is a secret reference, also one made by another copy of the core. */
export function isSecretReference(value: unknown): value is SecretReference {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

/**
 * Parses `<scheme>://<path>[#<key>][?version=<version>]`; throws `Invalid secret reference <text>: <reason>` when the
 * text does not match.
 */
export function parseSecretReference(text: string): SecretReference {
  const invalid = (reason: string) => new Error(`Invalid secret reference ${text}: ${reason}`);
  if (typeof text !== "string") throw new Error(`Invalid secret reference ${String(text)}: expected a text`);
  const separator = text.indexOf("://");
  if (separator < 0) throw invalid(REFERENCE_SYNTAX);
  const scheme = text.slice(0, separator);
  if (!SECRET_SCHEME.test(scheme)) throw invalid(`the scheme ${JSON.stringify(scheme)} must match ${SECRET_SCHEME.source}`);
  let rest = text.slice(separator + 3);
  let version: string | undefined;
  const query = rest.indexOf("?");
  if (query >= 0) {
    const match = /^version=([^&#?]+)$/.exec(rest.slice(query + 1));
    if (!match) throw invalid("the only query is ?version=<version>");
    version = decodeURIComponent(match[1]!);
    rest = rest.slice(0, query);
  }
  let key: string | undefined;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    key = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (key === "") throw invalid("the key after # is empty");
  }
  if (rest === "") throw invalid("the path is empty");
  return new SecretReference({ scheme, path: rest, ...(key !== undefined ? { key } : {}), ...(version !== undefined ? { version } : {}), text });
}

/** The value of a resolved secret, with the version the provider resolved. */
export interface StoredSecret {
  value: string;
  version?: string;
}

/** The current values of resolved references, by reference text. */
const resolvedValues = new Map<string, StoredSecret>();
/** Listeners of value changes, by reference text. */
const valueListeners = new Map<string, Set<(value: string) => void>>();

/** Every secret value resolved in this process (current and earlier ones), which logs, errors and reports mask. */
const knownValues = new Set<string>();
const knownListeners = new Set<() => void>();

/** The secret values resolved in this process, earlier values of rotated secrets included. */
export function knownSecretValues(): string[] {
  return [...knownValues];
}

/** Adds values to the known secret values, so they are masked wherever secrets are. */
export function addKnownSecretValues(values: readonly string[]): void {
  let added = false;
  for (const value of values) {
    if (typeof value !== "string" || value === "" || knownValues.has(value)) continue;
    knownValues.add(value);
    added = true;
  }
  if (!added) return;
  for (const listener of [...knownListeners]) listener();
}

/** Calls `fn` whenever a secret value is added to the known values; returns a function that removes it. */
export function onKnownSecretValues(fn: () => void): () => void {
  knownListeners.add(fn);
  return () => void knownListeners.delete(fn);
}

/** Stores the value a reference resolved to, makes it a known secret value and tells the reference's listeners. */
export function storeSecretValue(text: string, stored: StoredSecret): void {
  const previous = resolvedValues.get(text);
  resolvedValues.set(text, { ...stored });
  addKnownSecretValues([stored.value]);
  if (previous === undefined || previous.value === stored.value) return;
  for (const listener of [...(valueListeners.get(text) ?? [])]) {
    try {
      listener(stored.value);
    } catch {
      // A listener never stops the others.
    }
  }
}

/** The value and version a reference resolved to, or undefined before it resolved. */
export function storedSecret(text: string): StoredSecret | undefined {
  return resolvedValues.get(text);
}

/** Forgets every resolved value (not the known values, which stay masked); a service starting again resolves anew. */
export function clearStoredSecrets(): void {
  resolvedValues.clear();
}

/** Calls `fn` with the new value each time the reference's value changes; returns a function that removes it. */
export function onSecretValue(reference: SecretReference | string, fn: (value: string) => void): () => void {
  const text = typeof reference === "string" ? reference : reference.text;
  let listeners = valueListeners.get(text);
  if (!listeners) valueListeners.set(text, (listeners = new Set()));
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The environment of the configuration resolved last, which `env://` references read. */
let environment: Record<string, string | undefined> | undefined;

/** Sets the environment `env://` references read; `resolveConfig` sets the one it resolved with. */
export function setSecretEnvironment(env: Record<string, string | undefined> | undefined): void {
  environment = env;
}

/** The environment `env://` references read: the one the configuration resolved with, or the process's. */
export function secretEnvironment(): Record<string, string | undefined> {
  return environment ?? process.env;
}

/** A failure to resolve a reference whose message never holds a value. */
const failure = (reference: SecretReference, reason: string) => new Error(`${reference.text}: ${reason}`);

/**
 * The value of the built-in `env` and `file` schemes: `env://NAME` reads the variable (failing when it is unset or
 * empty) and `file://<path>` the file's content without one trailing line break, relative to the working directory
 * unless absolute.
 */
export function readBuiltInSecret(reference: SecretReference, env: Record<string, string | undefined> = secretEnvironment()): string {
  if (reference.scheme === "env") {
    const value = env[reference.path];
    if (value === undefined || value === "") throw failure(reference, `the variable ${reference.path} is not set`);
    return value;
  }
  if (reference.scheme === "file") {
    const path = isAbsolute(reference.path) ? reference.path : resolvePath(process.cwd(), reference.path);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw failure(reference, code === "ENOENT" ? "not found" : code === "EACCES" ? "access denied" : `cannot read the file (${code ?? "error"})`);
    }
    return content.replace(/\r?\n$/, "");
  }
  throw failure(reference, `no built-in provider for ${reference.scheme}`);
}

/**
 * The text a reference's `#key` selects: from `values[key]` when the provider gave several values, otherwise from the
 * value parsed as JSON; a reference without a key takes the value, or the only entry of `values`.
 */
export function selectSecretKey(reference: SecretReference, result: { value?: unknown; values?: Readonly<Record<string, unknown>> }): string {
  const key = reference.key;
  if (result.values !== undefined && result.values !== null && typeof result.values === "object") {
    const entries = Object.entries(result.values);
    if (key === undefined) {
      if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1];
      if (entries.length === 0) throw failure(reference, "the secret has no keys");
      throw failure(reference, "the secret has several keys; add #<key>");
    }
    const value = result.values[key];
    if (value === undefined) throw failure(reference, `no key ${key}`);
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (typeof result.value !== "string") throw failure(reference, "the provider returned no value");
  if (key === undefined) return result.value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.value);
  } catch {
    throw failure(reference, "the value is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw failure(reference, "the value is not JSON");
  if (!Object.hasOwn(parsed, key)) throw failure(reference, `no key ${key}`);
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The current value of a reference: the value it resolved to at startup (or after its last rotation). Outside a
 * service, an `env://` or `file://` reference is read directly; any other one throws.
 */
export function secretValue(reference: SecretReference | string): string {
  if (typeof reference === "string") return reference;
  const stored = resolvedValues.get(reference.text);
  if (stored) return stored.value;
  if (BUILT_IN_SECRET_SCHEMES.includes(reference.scheme)) {
    const value = selectSecretKey(reference, { value: readBuiltInSecret(reference) });
    addKnownSecretValues([value]);
    return value;
  }
  throw new Error(`${reference.text} is not resolved; secrets resolve when the service starts with secrets: {}`);
}

/** A reference found in the configuration: its config path, and how to put its value in place of it. */
export interface ReferenceLocation {
  path: string;
  reference: SecretReference;
  /** Puts the resolved value where the reference was; absent where the consumer keeps the reference (adapters). */
  replace?: (value: string) => void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The references inside plain objects and arrays of `value`, with the path of each under `prefix`. */
export function referencesIn(value: unknown, prefix: string): ReferenceLocation[] {
  const found: ReferenceLocation[] = [];
  const seen = new Set<object>();
  const visit = (current: unknown, path: string, depth: number) => {
    if (depth > 12 || typeof current !== "object" || current === null || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        if (isSecretReference(item)) found.push({ path: `${path}[${index}]`, reference: item, replace: (resolved) => void (current[index] = resolved) });
        else visit(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }
    if (!isPlainObject(current)) return;
    for (const key of Object.keys(current)) {
      const item = current[key];
      const at = path ? `${path}.${key}` : key;
      // The value replacing a reference prints masked, like a secret option.
      if (isSecretReference(item)) found.push({ path: at, reference: item, replace: (resolved) => (current[key] = resolved, maskSecrets(current, [key])) });
      else visit(item, at, depth + 1);
    }
  };
  visit(value, prefix, 0);
  return found;
}

/** Whether `value` holds a secret reference in its plain objects and arrays. */
export function containsSecretReference(value: unknown): boolean {
  return isSecretReference(value) || referencesIn(value, "").length > 0;
}

/** What the `secrets` native's API exposes under this symbol: the startup resolution the lifecycle runs. */
export const RESOLVE_STARTUP_SECRETS = Symbol.for("quickservicets.secrets.resolveStartup");

/** Whether a feature belongs to the secrets group, set up before every other feature: the native and the features using it. */
export function usesSecrets(definition: { key: string; requires: readonly { name: string }[]; enables: readonly string[] }): boolean {
  return definition.key === "secrets" || definition.requires.some((requirement) => requirement.name === "secrets") || definition.enables.includes("secrets");
}

/** What the `secrets` native gives `secrets.get` while a service runs. */
export interface SecretsRuntime {
  /** The current value of a reference, resolved through the providers and the cache. */
  get(reference: SecretReference): Promise<string>;
}

let runtime: SecretsRuntime | undefined;

/** Sets the runtime of the `secrets` native of the running service (undefined when it stops). */
export function setSecretsRuntime(next: SecretsRuntime | undefined): void {
  runtime = next;
}

const referenceOf = (reference: SecretReference | string): SecretReference => (typeof reference === "string" ? parseSecretReference(reference) : reference);

/**
 * Secrets read at runtime through the providers and the cache of the `secrets` native: `get` resolves a reference
 * once (one resolution in flight) and keeps it fresh like the configuration's, and `onRotate` calls a function with the
 * new value after each change, for code holding a derived object such as a client.
 */
export const secrets = {
  /** The current value of `reference`, like `await secrets.get("vault://kv/partner#key")`. */
  async get(reference: SecretReference | string): Promise<string> {
    const parsed = referenceOf(reference);
    if (!runtime) throw new Error(`secrets.get(${parsed.text}) needs the secrets native; add secrets: {} to quickservicets.config.ts`);
    return runtime.get(parsed);
  },
  /** Calls `fn(newValue)` after each change of the reference's value; returns a function that removes it. */
  onRotate(reference: SecretReference | string, fn: (value: string) => void): () => void {
    return onSecretValue(referenceOf(reference), fn);
  },
};
