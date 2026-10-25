import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config.ts";
import type { ServiceRequest } from "./hooks.ts";
import {
  boolean,
  describeOptions,
  duration,
  integer,
  list,
  number,
  object,
  oneOf,
  OptionError,
  parseOptionString,
  provider,
  resolveOption,
  resolveOptions,
  secret,
  size,
  string,
  url,
  type AnyOptionSchema,
} from "./options.ts";

const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const problems = (schema: AnyOptionSchema, input: unknown, path = "x") => {
  const error = failure(() => resolveOptions(schema, input, path));
  expect(error).toBeInstanceOf(ConfigError);
  return error.message.split("\n");
};

interface Store {
  read(key: string): string;
  write(key: string, value: string): void;
}

const history = object({
  retention: duration().default("90d"),
  size: size().optional(),
  mode: oneOf(["fast", "safe"]).default("safe"),
});

describe("builders and modifiers", () => {
  test("every kind accepts its values", () => {
    const cases: [AnyOptionSchema, unknown][] = [
      [string(), "a"],
      [number(), 1.5],
      [integer(), 3],
      [boolean(), false],
      [duration(), "30s"],
      [size(), "10MB"],
      [size(), 512],
      [url(), "https://example.com/x"],
      [url().protocols(["postgres"]), "postgres://localhost/db"],
      [oneOf(["a", "b"]), "b"],
      [list(string()), ["a"]],
      [object({ a: string() }), { a: "x" }],
      [secret(), "s3cr3t"],
      [provider<Store>("Store", ["read", "write"]), { read: () => "", write: () => {} }],
    ];
    for (const [schema, value] of cases) expect(resolveOptions(schema, value, "x")).toEqual(value as never);
  });

  test("every kind rejects other values with its expectation", () => {
    expect(problems(string(), 1)).toEqual(["Invalid x: expected a string, got 1"]);
    expect(problems(number(), "1")).toEqual(['Invalid x: expected a number, got "1"']);
    expect(problems(integer(), 1.5)).toEqual(["Invalid x: expected an integer, got 1.5"]);
    expect(problems(boolean(), "yes")).toEqual(['Invalid x: expected true or false, got "yes"']);
    expect(problems(duration(), "soon")[0]).toStartWith('Invalid x: expected a duration like 30s, 10m or 30d');
    expect(problems(size(), "big")).toEqual(['Invalid x: expected a size in bytes or like 10MB, got "big"']);
    expect(problems(url(), "ftp://x")).toEqual(['Invalid x: expected an http or https URL, got "ftp://x"']);
    expect(problems(url(), "not a url")).toHaveLength(1);
    expect(problems(url().protocols(["redis"]), "https://x")).toEqual(['Invalid x: expected a URL with protocol redis, got "https://x"']);
    expect(problems(oneOf(["a", "b"]), "c")).toEqual(['Invalid x: expected one of "a", "b", got "c"']);
    expect(problems(list(integer()), ["1", 2])).toEqual(['Invalid x[0]: expected an integer, got "1"']);
    expect(problems(list(string()), "a")).toEqual(['Invalid x: expected a list, got "a"']);
    expect(problems(object({}), [])).toEqual(["Invalid x: expected an object, got []"]);
    expect(problems(provider<Store>("Store", ["read", "write"]), { read: () => "" })).toEqual([
      'Invalid x: expected a Store with the methods read, write, got {}',
    ]);
  });

  test("min and max bound values, lengths and item counts", () => {
    expect(problems(integer().min(1).max(5), 9)).toEqual(["Invalid x: expected an integer of at most 5, got 9"]);
    expect(problems(integer().min(1).max(5), 0)).toEqual(["Invalid x: expected an integer of at least 1, got 0"]);
    expect(problems(integer().min(1).max(5), "x")).toEqual(['Invalid x: expected an integer between 1 and 5, got "x"']);
    expect(problems(number().min(0), -1)).toEqual(["Invalid x: expected a number of at least 0, got -1"]);
    expect(problems(string().max(2), "abc")).toEqual(['Invalid x: expected a string of at most 2 characters, got "abc"']);
    expect(problems(string().min(1).max(3), "")).toEqual(['Invalid x: expected a string of at least 1 character, got ""']);
    expect(problems(string().min(1).max(3), 4)).toEqual(["Invalid x: expected a string of 1 to 3 characters, got 4"]);
    expect(problems(list(string()).min(1), [])).toEqual(["Invalid x: expected a list of at least 1 item, got []"]);
    expect(problems(secret().min(8), "short")).toEqual(["Invalid x: expected a string of at least 8 characters, got [secret]"]);
    expect(resolveOptions(list(string()).max(2), ["a", "b"], "x")).toEqual(["a", "b"]);
  });

  test("defaults are checked when they are defined", () => {
    expect(failure(() => integer().min(1).default(0)).message).toBe("Invalid default: expected an integer of at least 1, got 0");
    expect(failure(() => integer().default(0).min(1)).message).toBe("Invalid default: expected an integer of at least 1, got 0");
    expect(failure(() => duration().default("later")).message).toStartWith("Invalid default: expected a duration");
    expect(failure(() => url().default("https://x").protocols(["redis"])).message).toContain("expected a URL with protocol redis");
    expect(failure(() => (secret() as unknown as { default(value: string): unknown }).default("x")).message).toBe("secret() options cannot have a default");
    expect(failure(() => oneOf([])).message).toBe("oneOf() needs at least one value");
  });

  test("schemas are immutable: modifiers return new nodes", () => {
    const base = string();
    const described = base.describe("Name").example("ann").optional();
    expect(base.settings).toEqual({ hasDefault: false, optional: false, perRequest: false });
    expect(described.settings).toMatchObject({ description: "Name", example: "ann", optional: true });
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.settings)).toBe(true);
  });
});

describe("resolution", () => {
  test("defaults apply at every level and optional keys stay absent", () => {
    const input = {};
    expect(resolveOptions(history, input, "history")).toEqual({ retention: "90d", mode: "safe" });
    expect(input).toEqual({});
    const nested = object({ cleanup: object({ every: duration().default("1h"), batch: integer().default(100) }), extra: object({ on: boolean() }).optional() });
    expect(resolveOptions(nested, {}, "jobs")).toEqual({ cleanup: { every: "1h", batch: 100 } });
    expect(resolveOptions(nested, { cleanup: { batch: 5 } }, "jobs")).toEqual({ cleanup: { every: "1h", batch: 5 } });
  });

  test("the input is never mutated and default values are copied", () => {
    const schema = object({ tags: list(string()).default(["a"]), meta: object({ deep: list(integer()) }) });
    const input = { meta: { deep: [1, 2] } };
    const frozen = structuredClone(input);
    const first = resolveOptions(schema, input, "x");
    expect(input).toEqual(frozen);
    (first.tags as string[]).push("changed");
    expect(resolveOptions(schema, input, "x").tags).toEqual(["a"]);
    expect(first.meta.deep).not.toBe(input.meta.deep);
  });

  test("a required option without a value is reported", () => {
    expect(problems(object({ name: string() }), {}, "service")).toEqual(["Invalid service.name: expected a string, got undefined"]);
  });
});

describe("errors", () => {
  test("every problem is listed in one ConfigError, with suggestions for unknown keys", () => {
    const error = failure(() => resolveOptions(history, { retention: "soon", mode: "x", retension: "1d" }, "history"));
    expect(error).toBeInstanceOf(ConfigError);
    const lines = error.message.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith('Invalid history.retention: expected a duration like 30s, 10m or 30d');
    expect(lines[0]).toEndWith('got "soon"');
    expect(lines[1]).toBe('Invalid history.mode: expected one of "fast", "safe", got "x"');
    expect(lines[2]).toBe("Unknown option history.retension (did you mean retention?)");
  });

  test("unknown keys far from every declared key get no suggestion", () => {
    expect(problems(history, { colour: "red" }, "history")).toEqual(["Unknown option history.colour"]);
  });

  test("secret values never appear in messages", () => {
    const lines = problems(object({ apiKey: secret(), token: secret().min(10) }), { apiKey: 12345, token: "hunter2" }, "auth");
    expect(lines).toEqual(["Invalid auth.apiKey: expected a string, got [secret]", "Invalid auth.token: expected a string of at least 10 characters, got [secret]"]);
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(lines.join("\n")).not.toContain("12345");
  });
});

describe("environment strings", () => {
  test("each kind is parsed from text", () => {
    expect(parseOptionString(boolean(), "TRUE")).toBe(true);
    expect(parseOptionString(boolean(), "0")).toBe(false);
    expect(parseOptionString(boolean(), "False")).toBe(false);
    expect(parseOptionString(boolean(), "1")).toBe(true);
    expect(parseOptionString(list(string()), "a, b")).toEqual(["a", "b"]);
    expect(parseOptionString(list(string()), '["a","b"]')).toEqual(["a", "b"]);
    expect(parseOptionString(list(integer()), "1, 2,3")).toEqual([1, 2, 3]);
    expect(parseOptionString(object({ x: integer() }), '{"x":1}')).toEqual({ x: 1 });
    expect(parseOptionString(integer(), "42")).toBe(42);
    expect(parseOptionString(number(), "-4.5")).toBe(-4.5);
    expect(parseOptionString(duration(), "5m")).toBe("5m");
    expect(parseOptionString(size(), "1024")).toBe("1024");
    expect(parseOptionString(string(), " spaced ")).toBe(" spaced ");
    expect(parseOptionString(oneOf([1, 2]), "2")).toBe(2);
    expect(parseOptionString(secret(), "s3cr3t")).toBe("s3cr3t");
  });

  test("invalid text is reported like any other value", () => {
    expect(failure(() => parseOptionString(integer(), "4.5", "QS_X")).message).toBe("Invalid QS_X: expected an integer, got 4.5");
    expect(failure(() => parseOptionString(boolean(), "yes")).message).toBe('Invalid value: expected true or false, got "yes"');
    expect(failure(() => parseOptionString(object({ x: integer() }), "{x:1}")).message).toBe('Invalid value: expected an object, got "{x:1}"');
    expect(failure(() => parseOptionString(number(), "abc")).message).toBe('Invalid value: expected a number, got "abc"');
  });

  test("an empty string means not set", () => {
    for (const schema of [string(), integer(), boolean(), list(string()), object({})]) expect(parseOptionString(schema, "")).toBeUndefined();
  });
});

const request = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as ServiceRequest;

describe("per-request values", () => {
  const plans = object({ plan: string().perRequest().default("free"), limit: integer().default(10) });

  test("a function receives the request and its result is returned", async () => {
    const options = resolveOptions(plans, { plan: ({ req }) => req?.headers.get("x-plan") ?? "free" }, "billing");
    expect(await resolveOption(options.plan, { req: request({ "x-plan": "pro" }) })).toBe("pro");
    expect(await resolveOption(options.plan, {})).toBe("free");
    expect(resolveOption(options.limit, { req: request({}) })).toBe(10);
    expect(resolveOption(resolveOptions(plans, {}, "billing").plan, { req: undefined })).toBe("free");
  });

  test("outside a request the function receives req undefined", async () => {
    let seen: unknown = "unset";
    const options = resolveOptions(plans, { plan: (ctx) => ((seen = ctx.req), "job") }, "billing");
    expect(await resolveOption(options.plan)).toBe("job");
    expect(seen).toBeUndefined();
  });

  test("options without perRequest reject functions", () => {
    expect(problems(object({ plan: string() }), { plan: () => "x" }, "billing")).toEqual(["Invalid billing.plan: expected a string, got a function"]);
  });

  test("a function returning an invalid value, or throwing, fails naming the option", async () => {
    const wrong = resolveOptions(plans, { plan: () => 42 as unknown as string }, "billing");
    expect(failure(() => resolveOption(wrong.plan, { req: request({}) }))).toBeInstanceOf(OptionError);
    expect(failure(() => resolveOption(wrong.plan, { req: request({}) })).message).toBe("Invalid billing.plan: expected a string, got 42");
    const asyncWrong = resolveOptions(plans, { plan: async () => 42 as unknown as string }, "billing");
    expect(resolveOption(asyncWrong.plan, {})).rejects.toThrow("Invalid billing.plan: expected a string, got 42");
    const throwing = resolveOptions(plans, {
      plan: () => {
        throw new Error("no plan service");
      },
    }, "billing");
    expect(failure(() => resolveOption(throwing.plan, {})).message).toBe("Option billing.plan failed: no plan service");
    const rejecting = resolveOptions(plans, { plan: async () => Promise.reject(new Error("down")) }, "billing");
    expect(resolveOption(rejecting.plan, {})).rejects.toThrow("Option billing.plan failed: down");
  });
});

describe("descriptions", () => {
  test("one flat entry per leaf, in declaration order", () => {
    const schema = object({
      retention: duration().default("90d").describe("How long entries are kept.").example("30d"),
      store: object({ apiKey: secret().describe("Key of the store."), modes: list(oneOf(["a", "b"])).optional() }),
      plan: string().perRequest().default("free"),
      backend: provider<Store>("Store", ["read", "write"]).optional(),
    });
    expect(describeOptions(schema, "history")).toEqual([
      { path: "history.retention", type: "duration", default: "90d", description: "How long entries are kept.", example: "30d", secret: false, optional: false, perRequest: false },
      { path: "history.store.apiKey", type: "string", description: "Key of the store.", secret: true, optional: false, perRequest: false },
      { path: "history.store.modes", type: '("a" | "b")[]', secret: false, optional: true, perRequest: false },
      { path: "history.plan", type: "string", default: "free", secret: false, optional: false, perRequest: true },
      { path: "history.backend", type: "Store", secret: false, optional: true, perRequest: false },
    ]);
    expect(describeOptions(object({ mode: oneOf(["fast", "safe"]) }), "x")[0]!.type).toBe('"fast" | "safe"');
    expect(describeOptions(list(string()), "tags")).toEqual([{ path: "tags", type: "string[]", secret: false, optional: false, perRequest: false }]);
  });
});
