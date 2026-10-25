import { expect, test } from "bun:test";
import { duration, integer, list, object, oneOf, provider, resolveOptions, secret, size, string, type Options, type OptionsInput } from "./options.ts";

interface Store {
  read(key: string): string;
  write(key: string, value: string): void;
}

const schema = object({
  retention: duration().default("90d"),
  size: size().optional(),
  mode: oneOf(["fast", "safe"]).default("safe"),
  plan: string().perRequest().optional(),
  tags: list(string()).default([]),
  limits: object({ max: integer() }),
});

// Type-level checks: this function is compiled by tsc but never called.
function typed(options: Options<typeof schema>) {
  const retention: string = options.retention;
  const sizeValue: string | number | undefined = options.size;
  // @ts-expect-error size may be undefined
  const sizeRequired: string | number = options.size;
  const mode: "fast" | "safe" = options.mode;
  const tags: string[] = options.tags;
  const max: number = options.limits.max;
  const plan = options.plan;
  const planValue: string | ((ctx: never) => string | Promise<string>) | undefined = plan;

  const minimal: OptionsInput<typeof schema> = { limits: { max: 1 } };
  const full: OptionsInput<typeof schema> = {
    retention: "1d",
    size: 10,
    mode: "fast",
    plan: ({ req }) => req?.headers.get("x-plan") ?? "free",
    tags: ["a"],
    limits: { max: 2 },
  };
  // @ts-expect-error retention is a duration string
  const wrongRetention: OptionsInput<typeof schema> = { retention: 5, limits: { max: 1 } };
  // @ts-expect-error limits is required: it has no default
  const missingLimits: OptionsInput<typeof schema> = {};
  // @ts-expect-error mode only takes its values
  const wrongMode: OptionsInput<typeof schema> = { mode: "slow", limits: { max: 1 } };
  // @ts-expect-error only perRequest options take functions
  const wrongFunction: OptionsInput<typeof schema> = { mode: () => "fast", limits: { max: 1 } };

  const store = provider<Store>("Store", ["read", "write"]);
  const stores = object({ store });
  const good: OptionsInput<typeof stores> = { store: { read: () => "", write: () => {} } };
  // @ts-expect-error an object without write is not a Store
  const bad: OptionsInput<typeof stores> = { store: { read: () => "" } };
  // @ts-expect-error methods must be keys of the interface
  provider<Store>("Store", ["read", "remove"]);

  // @ts-expect-error secrets cannot have a default
  secret().default("x");

  const resolved = resolveOptions(schema, {}, "x");
  const resolvedRetention: string = resolved.retention;

  return [retention, sizeValue, sizeRequired, mode, tags, max, planValue, minimal, full, wrongRetention, missingLimits, wrongMode, wrongFunction, good, bad, resolvedRetention];
}

test("option types follow the schema", () => {
  expect(typed).toBeDefined();
});
