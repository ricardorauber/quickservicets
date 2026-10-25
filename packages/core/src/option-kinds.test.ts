import { describe, expect, test } from "bun:test";
import { matchesCidr } from "./cidr.ts";
import { ConfigError } from "./config-error.ts";
import { applyEnvironment, featureVariables, unknownVariableWarnings } from "./environment.ts";
import { defineFeature } from "./features.ts";
import { cidr, describeOptions, list, object, parseOptionString, rate, record, resolveOptions, string, toggle, url, type Options, type OptionsInput } from "./options.ts";
import { parseRate } from "./rates.ts";

const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

const corsSchema = object({ cors: toggle({ origins: list(string()).default([]) }) });

describe("toggle", () => {
  test("true, false and objects all resolve to an object with enabled", () => {
    expect(resolveOptions(corsSchema, {}, "security")).toEqual({ cors: { enabled: true, origins: [] } });
    expect(resolveOptions(corsSchema, { cors: true }, "security")).toEqual({ cors: { enabled: true, origins: [] } });
    expect(resolveOptions(corsSchema, { cors: false }, "security")).toEqual({ cors: { enabled: false, origins: [] } });
    expect(resolveOptions(corsSchema, { cors: { origins: ["https://a.dev"] } }, "security")).toEqual({ cors: { enabled: true, origins: ["https://a.dev"] } });
  });

  test(".default(false) keeps the section off unless given, and a shape may not declare enabled", () => {
    const schema = object({ log: toggle({ path: string().default("/tmp/log") }).default(false) });
    expect(resolveOptions(schema, {}, "audit")).toEqual({ log: { enabled: false, path: "/tmp/log" } });
    expect(resolveOptions(schema, { log: { path: "/x" } }, "audit")).toEqual({ log: { enabled: true, path: "/x" } });
    expect(() => toggle({ enabled: string() })).toThrow("toggle() declares enabled itself");
  });

  test("other values and unknown keys are reported", () => {
    expect(failure(() => resolveOptions(corsSchema, { cors: "yes" }, "security")).message).toBe('Invalid security.cors: expected true, false or an object, got "yes"');
    expect(failure(() => resolveOptions(corsSchema, { cors: { origin: [] } }, "security")).message).toBe("Unknown option security.cors.origin (did you mean origins?)");
  });
});

describe("record", () => {
  const services = object({ services: record(object({ url: url() })) });

  test("entries are resolved with the value schema and reported under their names", () => {
    expect(resolveOptions(services, {}, "http")).toEqual({ services: {} });
    expect(resolveOptions(services, { services: { billing: { url: "https://b.dev" }, "my-api": { url: "http://m.dev" } } }, "http")).toEqual({
      services: { billing: { url: "https://b.dev" }, "my-api": { url: "http://m.dev" } },
    });
    expect(failure(() => resolveOptions(services, { services: { billing: { url: "nope" } } }, "http")).message).toBe(
      'Invalid http.services.billing.url: expected an absolute http or https URL, got "nope"',
    );
    expect(failure(() => resolveOptions(services, { services: { "1st": { url: "https://a.dev" } } }, "http")).message).toBe(
      'Invalid http.services: the entry name "1st" must match ^[A-Za-z][A-Za-z0-9_-]*$',
    );
    expect(failure(() => resolveOptions(services, { services: { billing: { uri: "x" } } }, "http")).message).toContain("Unknown option http.services.billing.uri (did you mean url?)");
  });

  test("min and max bound the entry count", () => {
    const bounded = record(string()).min(1).max(2);
    expect(failure(() => resolveOptions(bounded, {}, "names")).message).toBe("Invalid names: expected an object of named entries of at least 1 entry, got {}");
    expect(failure(() => resolveOptions(bounded, { a: "1", b: "2", c: "3" }, "names")).message).toContain("of at most 2 entries");
  });
});

describe("rate", () => {
  test("every unit, multipliers and failures", () => {
    expect(parseRate("100/min")).toEqual({ count: 100, windowMs: 60_000 });
    expect(parseRate("5/10s")).toEqual({ count: 5, windowMs: 10_000 });
    expect(parseRate("10/s")).toEqual({ count: 10, windowMs: 1000 });
    expect(parseRate("3/2m")).toEqual({ count: 3, windowMs: 120_000 });
    expect(parseRate("1000/h")).toEqual({ count: 1000, windowMs: 3_600_000 });
    expect(parseRate("7/d")).toEqual({ count: 7, windowMs: 86_400_000 });
    expect(() => parseRate("10/week")).toThrow("expected a rate like 100/min");
    expect(() => parseRate("0/min")).toThrow("expected a rate like 100/min");
    expect(failure(() => resolveOptions(rate(), "10/week", "limit")).message).toBe('Invalid limit: expected a rate like 100/min, got "10/week"');
    expect(resolveOptions(rate(), "100/min", "limit")).toBe("100/min");
  });
});

describe("cidr", () => {
  test("addresses, blocks, names and IPv4-mapped matching", () => {
    expect(matchesCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(matchesCidr("::ffff:10.1.2.3", "private")).toBe(true);
    expect(matchesCidr("::1", "loopback")).toBe(true);
    expect(matchesCidr("127.0.0.1", "loopback")).toBe(true);
    expect(matchesCidr("8.8.8.8", "private")).toBe(false);
    expect(matchesCidr("fd12::1", "fd00::/8")).toBe(true);
    expect(matchesCidr("fe80::1", "linklocal")).toBe(true);
    expect(matchesCidr("169.254.1.1", "linklocal")).toBe(true);
    expect(matchesCidr("192.168.1.1", "192.168.1.1")).toBe(true);
    expect(matchesCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
    expect(matchesCidr("not an ip", "private")).toBe(false);
    expect(() => matchesCidr("10.0.0.1", "10.0.0.0/33")).toThrow("expected an IP address, a CIDR block or loopback, private or linklocal");
  });

  test("the option accepts addresses, blocks and names and rejects the rest", () => {
    for (const value of ["10.0.0.0/8", "fd00::/8", "::1", "1.2.3.4", "private", "loopback", "linklocal"]) expect(resolveOptions(cidr(), value, "allow")).toBe(value);
    expect(failure(() => resolveOptions(cidr(), "10.0.0.0/33", "allow")).message).toBe(
      'Invalid allow: expected an IP address, a CIDR block or loopback, private or linklocal, got "10.0.0.0/33"',
    );
    expect(failure(() => resolveOptions(cidr(), "1::2::3", "allow")).message).toContain("expected an IP address");
  });
});

describe("environment", () => {
  const security = defineFeature({ key: "security", options: object({ cors: toggle({ origins: list(string()).default([]) }), allow: list(cidr()).default([]) }) });
  const http = defineFeature({ key: "http", options: object({ services: record(object({ url: url(), timeout: string().optional() })) }) });
  const flags = defineFeature({ key: "flags", options: object({ rules: record(toggle({ users: list(string()).default([]) })) }) });
  const apply = (config: Record<string, unknown>, env: Record<string, string>) => applyEnvironment(config, env, [security, http, flags]).config;

  test("strings parse into toggles, records, rates and lists of cidrs", () => {
    expect(parseOptionString(toggle({}), "false")).toEqual({ enabled: false });
    expect(parseOptionString(toggle({}), "1")).toEqual({ enabled: true });
    expect(parseOptionString(toggle({ a: string().optional() }), '{"a":"x"}')).toEqual({ enabled: true, a: "x" });
    expect(parseOptionString(record(string()), '{"a":"x"}')).toEqual({ a: "x" });
    expect(parseOptionString(rate(), "5/10s")).toBe("5/10s");
    expect(parseOptionString(list(cidr()), "10.0.0.0/8, loopback")).toEqual(["10.0.0.0/8", "loopback"]);
  });

  test("a toggle has _ENABLED, key and whole variables, the whole one applied first", () => {
    expect(apply({ security: {} }, { QS_SECURITY_CORS_ENABLED: "false" }).security).toEqual({ cors: { enabled: false } });
    expect(apply({ security: {} }, { QS_SECURITY_CORS: "false" }).security).toEqual({ cors: { enabled: false, origins: [] } });
    expect(apply({ security: {} }, { QS_SECURITY_CORS: '{"origins":["https://a.dev"]}' }).security).toEqual({ cors: { enabled: true, origins: ["https://a.dev"] } });
    expect(apply({ security: {} }, { QS_SECURITY_CORS: "false", QS_SECURITY_CORS_ENABLED: "true" }).security).toMatchObject({ cors: { enabled: true } });
    expect(apply({ security: {} }, { QS_SECURITY_CORS: '{"origins":["https://a.dev"]}', QS_SECURITY_CORS_ENABLED: "false" }).security).toEqual({
      cors: { enabled: false, origins: ["https://a.dev"] },
    });
    // A toggle written as false in the config keeps it while one of its keys is set.
    expect(apply({ security: { cors: false } }, { QS_SECURITY_CORS_ORIGINS: "https://b.dev" }).security).toEqual({ cors: { enabled: false, origins: ["https://b.dev"] } });
    expect(apply({ security: {} }, { QS_SECURITY_ALLOW: "10.0.0.0/8, loopback" }).security).toEqual({ allow: ["10.0.0.0/8", "loopback"] });
  });

  test("a record's configured entries get variables, and the whole record is set from JSON first", () => {
    const configured = { http: { services: { billing: { url: "https://a.dev" }, "my-api": { url: "https://m.dev" } } } };
    expect(apply(configured, { QS_HTTP_SERVICES_BILLING_URL: "https://b.dev", QS_HTTP_SERVICES_MY_API_TIMEOUT: "5s" }).http).toEqual({
      services: { billing: { url: "https://b.dev" }, "my-api": { url: "https://m.dev", timeout: "5s" } },
    });
    expect(apply({ http: {} }, { QS_HTTP_SERVICES: '{"crm":{"url":"https://c.dev"}}' }).http).toEqual({ services: { crm: { url: "https://c.dev" } } });
    expect(apply({ http: {} }, { QS_HTTP_SERVICES: '{"crm":{"url":"https://c.dev"}}', QS_HTTP_SERVICES_CRM_URL: "https://d.dev" }).http).toEqual({
      services: { crm: { url: "https://d.dev" } },
    });
    expect(apply({ flags: { rules: { "checkout-v2": true } } }, { QS_FLAGS_RULES_CHECKOUT_V2: "false" }).flags).toEqual({ rules: { "checkout-v2": { enabled: false, users: [] } } });
    expect(failure(() => apply(configured, { QS_HTTP_SERVICES_BILLING_URL: "nope" })).message).toContain("Invalid QS_HTTP_SERVICES_BILLING_URL (http.services.billing.url)");
  });

  test("entry variables are known only for configured entries", () => {
    expect(unknownVariableWarnings({ QS_HTTP_SERVICES_BILLING_URL: "https://b.dev" }, [http], [], { http: { services: { billing: { url: "https://a.dev" } } } })).toEqual([]);
    expect(unknownVariableWarnings({ QS_HTTP_SERVICES_BILLING_URL: "https://b.dev" }, [http])[0]).toStartWith("Unknown environment variable QS_HTTP_SERVICES_BILLING_URL");
    expect([...featureVariables("security", security.schema).keys()]).toEqual(
      expect.arrayContaining(["QS_SECURITY_CORS", "QS_SECURITY_CORS_ENABLED", "QS_SECURITY_CORS_ORIGINS", "QS_SECURITY_ALLOW", "QS_SECURITY_ENABLED"]),
    );
  });

  test("invalid toggle text fails", () => {
    const error = failure(() => apply({ security: {} }, { QS_SECURITY_CORS: "maybe" }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe('Invalid QS_SECURITY_CORS (security.cors): expected true, false or an object, got "maybe"');
  });
});

describe("descriptions and types", () => {
  test("toggles describe enabled and their keys, records one row per value key, rates and cidrs by name", () => {
    const schema = object({
      cors: toggle({ origins: list(string()).default([]) }),
      services: record(object({ url: url() })),
      limit: rate().default("100/min"),
      allow: list(cidr()).default([]),
    });
    const rows = describeOptions(schema, "security");
    expect(rows.map((row) => [row.path, row.type])).toEqual([
      ["security.cors.enabled", "boolean"],
      ["security.cors.origins", "string[]"],
      ["security.services.<name>.url", "record of url"],
      ["security.limit", "rate"],
      ["security.allow", "cidr[]"],
    ]);
    expect(rows.find((row) => row.path === "security.limit")!.default).toBe("100/min");
    expect(rows[0]!.default).toBe(true);
  });

  test("option types follow the new kinds", () => {
    const schema = object({ cors: toggle({ origins: list(string()).default([]) }), services: record(object({ url: url() })), limit: rate().optional() });
    expect(typed).toBeFunction();
    // Type-level checks: this function is compiled by tsc but never called.
    function typed(options: Options<typeof schema>) {
      const enabled: boolean = options.cors.enabled;
      const origins: string[] = options.cors.origins;
      const billing: string | undefined = options.services["billing"]?.url;
      const limit: string | undefined = options.limit;
      const inputs: OptionsInput<typeof schema>[] = [{}, { cors: true }, { cors: false }, { cors: { origins: ["https://a.dev"] } }, { services: { a: { url: "x" } } }];
      // @ts-expect-error a toggle takes a boolean or an object
      const wrong: OptionsInput<typeof schema> = { cors: "yes" };
      return [enabled, origins, billing, limit, inputs, wrong];
    }
  });
});
