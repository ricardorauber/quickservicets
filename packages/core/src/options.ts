import { ConfigError } from "./config-error.ts";
import { parseSize } from "./files/limits.ts";
import type { ServiceRequest } from "./hooks.ts";
import { DURATION_UNITS, parseDuration } from "./jobs/job.ts";
import { CIDR_EXPECTATION, isCidr } from "./cidr.ts";
import { RATE_EXPECTATION, rateOf } from "./rates.ts";

/** The kinds of option schema nodes. */
export type OptionKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "duration"
  | "size"
  | "url"
  | "oneOf"
  | "list"
  | "object"
  | "secret"
  | "provider"
  | "toggle"
  | "record"
  | "rate"
  | "cidr";

/**
 * What a per-request option function receives: the request, undefined outside one (jobs, queues, setup code), and the
 * request's user and tenant.
 */
export interface OptionContext {
  req: ServiceRequest | undefined;
  user: ServiceRequest["user"];
  tenant: ServiceRequest["tenant"];
  [key: string]: unknown;
}

/** A per-request option value, computed for each request. */
export type OptionFunction<T> = (ctx: OptionContext) => T | Promise<T>;

/** The settings of a schema node, as its builders and modifiers set them. */
export interface OptionSettings {
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly optional: boolean;
  readonly perRequest: boolean;
  readonly description?: string;
  readonly example?: string;
  readonly min?: number;
  readonly max?: number;
  /** `oneOf` values. */
  readonly values?: readonly (string | number | boolean)[];
  /** `list` item schema, and `record` value schema. */
  readonly item?: AnyOptionSchema;
  /** `object` shape, and `toggle` shape with its `enabled` option. */
  readonly shape?: Readonly<Record<string, AnyOptionSchema>>;
  /** `url` protocols, without the colon. */
  readonly protocols?: readonly string[];
  /** `provider` interface name and required methods. */
  readonly name?: string;
  readonly methods?: readonly string[];
}

// Type-level markers set by the modifiers; they never exist at runtime.
interface Defaulted {
  readonly __default: true;
}
interface Optional {
  readonly __optional: true;
}
interface PerRequest {
  readonly __perRequest: true;
}

/** Any option schema node. */
export interface AnyOptionSchema {
  readonly kind: OptionKind;
  readonly settings: OptionSettings;
}

/** The modifiers every schema node has, except `.default()`. */
export interface BaseOptionSchema<T> extends AnyOptionSchema {
  /** The value type, for type inference only: it does not exist at runtime. */
  readonly __value: T;
  optional(): this & Optional;
  describe(text: string): this;
  example(text: string): this;
  /** Accepts a function of the request context as well as a value; read it with `resolveOption`. */
  perRequest(): this & PerRequest;
}

export interface OptionSchema<T> extends BaseOptionSchema<T> {
  /** The value used when the input leaves the option out; checked against the schema at once. */
  default(value: T): this & Defaulted;
}

/** A schema with `.min(n)` and `.max(n)`: of a number's value, a string's length or a list's item count. */
export interface BoundedOptionSchema<T> extends OptionSchema<T> {
  min(n: number): this;
  max(n: number): this;
}

/** A secret string: never shown in messages or docs, and never given a default. */
export interface SecretOptionSchema extends BaseOptionSchema<string> {
  /** Secrets cannot have a default: a default would be shared by every environment and appear in the docs. */
  default(value: never): never;
  min(n: number): this;
  max(n: number): this;
}

export interface UrlOptionSchema extends OptionSchema<string> {
  /** The protocols accepted instead of `http` and `https`, like `["postgres", "postgresql"]`. */
  protocols(protocols: readonly string[]): this;
}

export interface ListOptionSchema<I extends AnyOptionSchema> extends BoundedOptionSchema<PlainValue<I>[]> {
  /** The item schema, for type inference only. */
  readonly __item: I;
}

export interface ObjectOptionSchema<S extends Record<string, AnyOptionSchema>> extends OptionSchema<InputShape<S>> {
  /** The shape, for type inference only. */
  readonly __shape: S;
}

/** A switchable section: `true`, `false` or an object of its shape, always resolved to an object with `enabled`. */
export interface ToggleOptionSchema<S extends Record<string, AnyOptionSchema>> extends OptionSchema<boolean | (InputShape<S> & { enabled?: boolean })> {
  /** The shape, for type inference only. */
  readonly __toggle: S;
}

/** A map of user-named entries, each resolved with the value schema. */
export interface RecordOptionSchema<I extends AnyOptionSchema> extends BoundedOptionSchema<Record<string, InputValue<I>>> {
  /** The value schema, for type inference only. */
  readonly __record: I;
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ValueOf<S> = S extends { readonly __value: infer T } ? T : never;
type IsOptional<S> = S extends Optional ? true : false;
type HasDefault<S> = S extends Defaulted ? true : false;
type IsPerRequest<S> = S extends PerRequest ? true : false;

/** The value a schema validates, without per-request functions. */
type PlainValue<S> =
  S extends { readonly __toggle: infer Shape extends Record<string, AnyOptionSchema> }
    ? Simplify<ResolvedShape<Shape> & { enabled: boolean }>
    : S extends { readonly __record: infer I }
      ? Record<string, PlainValue<I>>
      : S extends ObjectOptionSchema<infer Shape>
        ? ResolvedShape<Shape>
        : S extends ListOptionSchema<infer I>
          ? PlainValue<I>[]
          : ValueOf<S>;
type InputValue<S> =
  S extends { readonly __toggle: infer Shape extends Record<string, AnyOptionSchema> }
    ? boolean | Simplify<InputShape<Shape> & { enabled?: boolean }>
    : S extends { readonly __record: infer I }
      ? Record<string, InputValue<I>>
      : S extends ObjectOptionSchema<infer Shape>
        ? InputShape<Shape>
        : S extends ListOptionSchema<infer I>
          ? InputValue<I>[]
          : ValueOf<S>;

type WithFunction<S, T> = IsPerRequest<S> extends true ? T | OptionFunction<T> : T;

type ResolvedShape<Shape extends Record<string, AnyOptionSchema>> = Simplify<
  { [K in keyof Shape as IsOptional<Shape[K]> extends true ? (HasDefault<Shape[K]> extends true ? K : never) : K]: WithFunction<Shape[K], PlainValue<Shape[K]>> } & {
    [K in keyof Shape as IsOptional<Shape[K]> extends true ? (HasDefault<Shape[K]> extends true ? never : K) : never]?: WithFunction<Shape[K], PlainValue<Shape[K]>>;
  }
>;

type InputShape<Shape extends Record<string, AnyOptionSchema>> = Simplify<
  { [K in keyof Shape as IsOptional<Shape[K]> extends true ? never : HasDefault<Shape[K]> extends true ? never : K]: WithFunction<Shape[K], InputValue<Shape[K]>> } & {
    [K in keyof Shape as IsOptional<Shape[K]> extends true ? K : HasDefault<Shape[K]> extends true ? K : never]?: WithFunction<Shape[K], InputValue<Shape[K]>>;
  }
>;

/** The input a schema accepts: keys with a default or `.optional()` may be left out; `.perRequest()` keys take functions. */
export type OptionsInput<S> = S extends { readonly __toggle: unknown } | { readonly __record: unknown } ? WithFunction<S, InputValue<S>> : S extends ObjectOptionSchema<infer Shape> ? InputShape<Shape> : WithFunction<S, InputValue<S>>;

/** The value `resolveOptions` returns: keys with a default are always present. */
export type Options<S> = S extends { readonly __toggle: unknown } | { readonly __record: unknown } ? WithFunction<S, PlainValue<S>> : S extends ObjectOptionSchema<infer Shape> ? ResolvedShape<Shape> : WithFunction<S, PlainValue<S>>;

const DURATION_EXAMPLES = Object.keys(DURATION_UNITS);

class OptionNode {
  constructor(
    readonly kind: OptionKind,
    readonly settings: OptionSettings,
  ) {
    Object.freeze(this);
  }

  private with(changes: Partial<OptionSettings>): OptionNode {
    const node = new OptionNode(this.kind, Object.freeze({ ...this.settings, ...changes }));
    // Constraints added after a default must still accept it.
    if (node.settings.hasDefault && ("min" in changes || "max" in changes || "protocols" in changes)) checkDefault(node, node.settings.default);
    return node;
  }

  default(value: unknown): OptionNode {
    if (this.kind === "secret") throw new Error("secret() options cannot have a default");
    checkDefault(this, value);
    return this.with({ hasDefault: true, default: value });
  }

  optional(): OptionNode {
    return this.with({ optional: true });
  }

  describe(text: string): OptionNode {
    return this.with({ description: text });
  }

  example(text: string): OptionNode {
    return this.with({ example: text });
  }

  perRequest(): OptionNode {
    return this.with({ perRequest: true });
  }

  min(n: number): OptionNode {
    return this.with({ min: n });
  }

  max(n: number): OptionNode {
    return this.with({ max: n });
  }

  protocols(protocols: readonly string[]): OptionNode {
    return this.with({ protocols: Object.freeze(protocols.map((protocol) => protocol.replace(/:$/, ""))) });
  }
}

function checkDefault(node: AnyOptionSchema, value: unknown): void {
  if (node.settings.perRequest && typeof value === "function") return;
  const problems: string[] = [];
  validate(node, value, "default", problems);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

const BASE: OptionSettings = Object.freeze({ hasDefault: false, optional: false, perRequest: false });
const node = (kind: OptionKind, settings: Partial<OptionSettings> = {}) => new OptionNode(kind, Object.freeze({ ...BASE, ...settings }));

export function string(): BoundedOptionSchema<string> {
  return node("string") as never;
}
export function number(): BoundedOptionSchema<number> {
  return node("number") as never;
}
export function integer(): BoundedOptionSchema<number> {
  return node("integer") as never;
}
export function boolean(): OptionSchema<boolean> {
  return node("boolean") as never;
}
/** A duration like `30s`, `10m`, `2h` or `30d`. */
export function duration(): OptionSchema<string> {
  return node("duration") as never;
}
/** A size in bytes, or like `512KB` or `10MB`. */
export function size(): OptionSchema<string | number> {
  return node("size") as never;
}
/** An absolute URL whose protocol is `http` or `https`, unless `.protocols([...])` lists others. */
export function url(): UrlOptionSchema {
  return node("url") as never;
}
export function oneOf<const V extends readonly (string | number | boolean)[]>(values: V): OptionSchema<V[number]> {
  if (values.length === 0) throw new Error("oneOf() needs at least one value");
  return node("oneOf", { values: Object.freeze([...values]) }) as never;
}
export function list<I extends AnyOptionSchema>(item: I): ListOptionSchema<I> {
  return node("list", { item }) as never;
}
export function object<S extends Record<string, AnyOptionSchema>>(shape: S): ObjectOptionSchema<S> {
  return node("object", { shape: Object.freeze({ ...shape }) }) as never;
}
/** A string flagged as secret: masked as `[secret]` in messages and left out of the docs' defaults. */
export function secret(): SecretOptionSchema {
  return node("secret") as never;
}
/** An object with every listed method, the form used to replace a feature's implementation. */
export function provider<T extends object>(name: string, methods: readonly (keyof T & string)[]): OptionSchema<T> {
  return node("provider", { name, methods: Object.freeze([...methods]) }) as never;
}

/**
 * A switchable section: accepts `true` (every default of `shape`), `false` (the same, off) or an object of `shape`, and
 * always resolves to an object with `enabled` (default true) and the keys of `shape`. `.default(false)` makes the
 * section off unless given.
 */
export function toggle<S extends Record<string, AnyOptionSchema>>(shape: S): ToggleOptionSchema<S> & Defaulted {
  if (Object.hasOwn(shape, "enabled")) throw new Error("toggle() declares enabled itself; remove enabled from its shape");
  return node("toggle", { shape: Object.freeze({ enabled: boolean().default(true).describe("Turns this section off when false."), ...shape }) }) as never;
}
/**
 * A map of user-named entries (keys like `billing` or `my-api`), each resolved with `value`, empty when absent;
 * `.min(n)` and `.max(n)` bound the count.
 */
export function record<I extends AnyOptionSchema>(value: I): RecordOptionSchema<I> & Defaulted {
  return node("record", { item: value }) as never;
}
/** A request rate like `100/min`, `10/s`, `1000/h` or `5/10s`; read it with `parseRate`. */
export function rate(): OptionSchema<string> {
  return node("rate") as never;
}
/** An IP address, a CIDR block (`10.0.0.0/8`, `fd00::/8`) or `loopback`, `private` or `linklocal`; match with `matchesCidr`. */
export function cidr(): OptionSchema<string> {
  return node("cidr") as never;
}

/** ` of 1 to 5 characters`, ` of at least 3 items`, or ` between 1 and 5` for numbers (no unit). */
function bounds(settings: OptionSettings, unit?: string): string {
  const { min, max } = settings;
  const plural = (word: string) => (word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`);
  const counted = (n: number) => (unit ? `${n} ${n === 1 ? unit : plural(unit)}` : String(n));
  if (min !== undefined && max !== undefined) return unit ? ` of ${min} to ${counted(max)}` : ` between ${min} and ${max}`;
  if (min !== undefined) return ` of at least ${counted(min)}`;
  if (max !== undefined) return ` of at most ${counted(max)}`;
  return "";
}

/** What a schema expects, as written in error messages. */
export function expectationOf(schema: AnyOptionSchema): string {
  const { settings } = schema;
  switch (schema.kind) {
    case "string":
    case "secret":
      return `a string${bounds(settings, "character")}`;
    case "number":
      return `a number${bounds(settings)}`;
    case "integer":
      return `an integer${bounds(settings)}`;
    case "boolean":
      return "true or false";
    case "duration":
      return `a duration like 30s, 10m or 30d (units ${DURATION_EXAMPLES.join(", ")})`;
    case "size":
      return "a size in bytes or like 10MB";
    case "url":
      return settings.protocols ? `an absolute URL with protocol ${settings.protocols.join(", ")}` : "an absolute http or https URL";
    case "oneOf":
      return `one of ${settings.values!.map((value) => JSON.stringify(value)).join(", ")}`;
    case "list":
      return `a list${bounds(settings, "item")}`;
    case "object":
      return "an object";
    case "provider":
      return `a ${settings.name} with the methods ${settings.methods!.join(", ")}`;
    case "toggle":
      return "true, false or an object";
    case "record":
      return `an object of named entries${bounds(settings, "entry")}`;
    case "rate":
      return RATE_EXPECTATION;
    case "cidr":
      return CIDR_EXPECTATION;
  }
}

/** A value as shown in messages; secrets are masked. */
function shown(schema: AnyOptionSchema, value: unknown): string {
  if (schema.kind === "secret") return "[secret]";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return String(value);
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function withinBounds(settings: OptionSettings, measure: number): boolean {
  return (settings.min === undefined || measure >= settings.min) && (settings.max === undefined || measure <= settings.max);
}

/** The edit distance between two keys, to suggest the declared key a typo meant. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The declared name closest to `key` within an edit distance of 2, or undefined. */
export function closestName(key: string, declared: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const candidate of declared) {
    const d = distance(key, candidate);
    if (d <= 2 && (!best || d < best.distance)) best = { key: candidate, distance: d };
  }
  return best?.key;
}

/** ` (did you mean <key>?)` for the declared key within an edit distance of 2 of `key`, or an empty string. */
export function suggestion(key: string, declared: readonly string[]): string {
  const best = closestName(key, declared);
  return best ? ` (did you mean ${best}?)` : "";
}

/** Marks a per-request function with the schema and path its results are checked against. */
const CHECKED = Symbol("quickservice.option");
type CheckedFunction = OptionFunction<unknown> & { [CHECKED]?: { schema: AnyOptionSchema; path: string } };

/** Validates `value` against `schema`, collecting problems; returns the value with nested defaults applied. */
function validate(schema: AnyOptionSchema, value: unknown, path: string, problems: string[]): unknown {
  const { settings } = schema;
  const invalid = () => {
    problems.push(`Invalid ${path}: expected ${expectationOf(schema)}, got ${shown(schema, value)}`);
    return undefined;
  };
  /** Within `min` and `max`; otherwise reports the bound the value breaks. */
  const bounded = (measure: number): boolean => {
    if (withinBounds(settings, measure)) return true;
    const broken = settings.min !== undefined && measure < settings.min ? { min: settings.min, max: undefined } : { min: undefined, max: settings.max };
    problems.push(`Invalid ${path}: expected ${expectationOf({ kind: schema.kind, settings: { ...settings, ...broken } })}, got ${shown(schema, value)}`);
    return false;
  };
  if (typeof value === "function") {
    if (!settings.perRequest) return invalid();
    const checked: CheckedFunction = (ctx) => (value as OptionFunction<unknown>)(ctx);
    checked[CHECKED] = { schema, path };
    return checked;
  }
  switch (schema.kind) {
    case "string":
    case "secret":
      if (typeof value !== "string") return invalid();
      return bounded(value.length) ? value : undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
      return bounded(value) ? value : undefined;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return invalid();
      return bounded(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : invalid();
    case "duration":
      return parseDuration(value) !== undefined ? value : invalid();
    case "size": {
      const bytes = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
      return (typeof bytes === "number" || typeof bytes === "string") && parseSize(bytes) !== undefined ? value : invalid();
    }
    case "url": {
      if (typeof value !== "string") return invalid();
      try {
        const protocol = new URL(value).protocol.replace(/:$/, "");
        return (settings.protocols ?? ["http", "https"]).includes(protocol) ? value : invalid();
      } catch {
        return invalid();
      }
    }
    case "oneOf":
      return settings.values!.includes(value as never) ? value : invalid();
    case "list": {
      if (!Array.isArray(value)) return invalid();
      if (!bounded(value.length)) return undefined;
      return value.map((item, index) => validate(settings.item!, item, `${path}[${index}]`, problems));
    }
    case "object":
      return isPlainObject(value) ? resolveShape(settings.shape!, value, path, problems) : invalid();
    case "toggle":
      if (typeof value === "boolean") return resolveShape(settings.shape!, value ? {} : { enabled: false }, path, problems);
      return isPlainObject(value) ? resolveShape(settings.shape!, value, path, problems) : invalid();
    case "record": {
      if (!isPlainObject(value)) return invalid();
      const keys = Object.keys(value);
      if (!bounded(keys.length)) return undefined;
      const entries: Record<string, unknown> = {};
      for (const key of keys) {
        if (!RECORD_KEY.test(key)) {
          problems.push(`Invalid ${path}: the entry name ${JSON.stringify(key)} must match ${RECORD_KEY.source}`);
          continue;
        }
        const resolved = resolveValue(settings.item!, value[key], join(path, key), problems);
        if (resolved.set) entries[key] = resolved.value;
      }
      return entries;
    }
    case "rate":
      return rateOf(value) ? value : invalid();
    case "cidr":
      return isCidr(value) ? value : invalid();
    case "provider":
      return (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        settings.methods!.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
        ? value
        : invalid();
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
/** The names a record's entries may have. */
const RECORD_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const copy = (value: unknown): unknown => (typeof value === "object" && value !== null ? structuredClone(value) : value);

function resolveValue(schema: AnyOptionSchema, value: unknown, path: string, problems: string[]): { set: boolean; value?: unknown } {
  const { settings } = schema;
  if (value !== undefined) return { set: true, value: validate(schema, value, path, problems) };
  if (settings.hasDefault) return { set: true, value: validate(schema, copy(settings.default), path, problems) };
  if (settings.optional) return { set: false };
  // A required object or toggle without input still gets its own defaults; a required record is empty.
  if (schema.kind === "object" || schema.kind === "toggle") return { set: true, value: resolveShape(settings.shape!, {}, path, problems) };
  if (schema.kind === "record") return { set: true, value: {} };
  problems.push(`Invalid ${path}: expected ${expectationOf(schema)}, got undefined`);
  return { set: false };
}

function resolveShape(shape: Readonly<Record<string, AnyOptionSchema>>, input: Record<string, unknown>, path: string, problems: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const resolved = resolveValue(schema, Object.hasOwn(input, key) ? input[key] : undefined, join(path, key), problems);
    if (resolved.set) output[key] = resolved.value;
  }
  const declared = Object.keys(shape);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(shape, key)) problems.push(`Unknown option ${join(path, key)}${suggestion(key, declared)}`);
  }
  return output;
}

/**
 * Validates `input` against `schema` and returns a new value with every default applied; optional keys without a
 * default stay absent. Throws one `ConfigError` listing every problem, one per line.
 */
export function resolveOptions<S extends AnyOptionSchema>(schema: S, input: OptionsInput<S>, path: string): Options<S>;
export function resolveOptions<S extends AnyOptionSchema>(schema: S, input: unknown, path: string): Options<S>;
export function resolveOptions<S extends AnyOptionSchema>(schema: S, input: unknown, path: string): Options<S> {
  const problems: string[] = [];
  const resolved = resolveValue(schema, input, path, problems);
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
  return resolved.value as Options<S>;
}

/** Converts one item of a comma-separated list or a whole environment string to the schema's type, before validation. */
function convertString(schema: AnyOptionSchema, raw: string): unknown {
  switch (schema.kind) {
    case "number":
    case "integer":
      return /^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(raw) ? Number(raw) : raw;
    case "boolean": {
      const text = raw.trim().toLowerCase();
      return text === "true" || text === "1" ? true : text === "false" || text === "0" ? false : raw;
    }
    case "list":
      if (raw.trimStart().startsWith("[")) return parseJson(raw);
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .map((item) => convertString(schema.settings.item!, item));
    case "object":
    case "record":
      return parseJson(raw);
    case "toggle": {
      const text = raw.trim().toLowerCase();
      if (text === "true" || text === "1") return true;
      if (text === "false" || text === "0") return false;
      return parseJson(raw);
    }
    case "oneOf": {
      const match = schema.settings.values!.find((value) => String(value) === raw);
      return match === undefined ? raw : match;
    }
    default:
      return raw;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Converts an environment string to the schema's type and validates it like `resolveOptions`: numbers from numeric
 * text, booleans from `true`, `false`, `1` or `0` in any case, lists from a JSON array or comma-separated items and
 * objects from JSON. An empty string means "not set" and returns undefined.
 */
export function parseOptionString<S extends AnyOptionSchema>(schema: S, raw: string, path = "value"): Options<S> | undefined {
  if (raw === "") return undefined;
  return resolveOptions(schema, convertString(schema, raw), path);
}

/** Thrown when a per-request option function fails or returns an invalid value; the request fails with 500. */
export class OptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OptionError";
  }
}

function checkResult(fn: CheckedFunction, result: unknown): unknown {
  const checked = fn[CHECKED];
  if (!checked) return result;
  const problems: string[] = [];
  const plain = { ...checked.schema, settings: { ...checked.schema.settings, perRequest: false } } as AnyOptionSchema;
  const value = validate(plain, result, checked.path, problems);
  if (problems.length > 0) throw new OptionError(problems.join("\n"));
  return value;
}

/**
 * The value of an option for one request: a plain value at once, or the result of its per-request function called
 * with `ctx`, checked against the option's schema. A function that throws or returns an invalid value throws an
 * `OptionError` naming the option.
 */
export function resolveOption<T>(value: T | OptionFunction<T>, ctx: Partial<OptionContext> = {}): T | Promise<T> {
  if (typeof value !== "function") return value;
  const fn = value as CheckedFunction;
  const path = fn[CHECKED]?.path ?? "option";
  const context: OptionContext = { ...ctx, req: ctx.req, user: ctx.user ?? ctx.req?.user, tenant: ctx.tenant ?? ctx.req?.tenant };
  const failed = (error: unknown) => {
    if (error instanceof OptionError) throw error;
    throw new OptionError(`Option ${path} failed: ${(error as Error)?.message ?? String(error)}`, { cause: error });
  };
  let result: unknown;
  try {
    result = fn(context);
  } catch (error) {
    return failed(error);
  }
  if (result instanceof Promise) return result.then((resolved) => checkResult(fn, resolved) as T, failed);
  return checkResult(fn, result) as T;
}

/** One leaf option, as the docs list it. */
export interface OptionDescription {
  path: string;
  /** A readable type, like `duration`, `"a" | "b"` or `string[]`. */
  type: string;
  /** Absent for secrets and options without a default. */
  default?: unknown;
  description?: string;
  example?: string;
  secret: boolean;
  optional: boolean;
  perRequest: boolean;
}

/** The readable type of a schema, as the docs show it. */
export function optionTypeOf(schema: AnyOptionSchema): string {
  const { settings } = schema;
  switch (schema.kind) {
    case "secret":
      return "string";
    case "oneOf":
      return settings.values!.map((value) => JSON.stringify(value)).join(" | ");
    case "list": {
      const item = optionTypeOf(settings.item!);
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    case "provider":
      return settings.name!;
    case "record":
      return `record of ${optionTypeOf(settings.item!)}`;
    default:
      return schema.kind;
  }
}

/** One flat entry per leaf option of `schema`, in declaration order, with paths under `path`. */
export function describeOptions(schema: AnyOptionSchema, path: string): OptionDescription[] {
  if (schema.kind === "object" || schema.kind === "toggle") {
    return Object.entries(schema.settings.shape!).flatMap(([key, child]) => describeOptions(child, join(path, key)));
  }
  if (schema.kind === "record") {
    return describeOptions(schema.settings.item!, join(path, "<name>")).map((entry) => ({ ...entry, type: `record of ${entry.type}` }));
  }
  const { settings } = schema;
  const secret = schema.kind === "secret";
  return [
    {
      path,
      type: optionTypeOf(schema),
      ...(settings.hasDefault && !secret && typeof settings.default !== "function" ? { default: settings.default } : {}),
      ...(settings.description !== undefined ? { description: settings.description } : {}),
      ...(settings.example !== undefined ? { example: settings.example } : {}),
      secret,
      optional: settings.optional,
      perRequest: settings.perRequest,
    },
  ];
}
