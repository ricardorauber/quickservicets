import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { env } from "./env-vars.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { integer, object, secret, string } from "./options.ts";
import { maskSecrets } from "./secrets.ts";

const SECRET = "sk_live_123";
const vars = env as unknown as Record<string, string>;
afterEach(() => unregisterNative("vault"));

describe("masking", () => {
  test("serializing and inspecting show [secret] while reads return the value", () => {
    const target: Record<string, unknown> = { name: "x", token: SECRET, nested: { key: SECRET, other: 1 } };
    maskSecrets(target, ["token", "nested.key", "absent"]);
    expect(target.token).toBe(SECRET);
    expect(JSON.parse(JSON.stringify(target))).toEqual({ name: "x", token: "[secret]", nested: { key: "[secret]", other: 1 } });
    expect(Bun.inspect(target)).not.toContain(SECRET);
    expect(Bun.inspect(target)).toContain("[secret]");
    expect(Object.keys(target)).toEqual(["name", "token", "nested"]);
  });

  test("the env object masks secret variables", () => {
    resolveConfig({ database: memoryAdapter(), env: { STRIPE_KEY: secret(), REPORT_HOUR: integer().default(6) } } as ServiceConfig, { STRIPE_KEY: SECRET });
    expect(vars.STRIPE_KEY).toBe(SECRET);
    expect(JSON.stringify(env)).toBe('{"STRIPE_KEY":"[secret]","REPORT_HOUR":6}');
    expect(Bun.inspect(env)).toContain("[secret]");
    expect(Bun.inspect(env)).not.toContain(SECRET);
    expect(Bun.inspect({ env })).not.toContain(SECRET);
  });

  test("the resolved config masks files.signingSecret and secret feature options", () => {
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "vault", options: object({ token: secret(), name: string().default("main") }) }));
    const config = resolveConfig({ database: memoryAdapter(), files: { signingSecret: SECRET }, vault: { token: SECRET } } as ServiceConfig, {});
    expect(config.files.signingSecret).toBe(SECRET);
    expect(config.features[0]!.options.token).toBe(SECRET);
    const json = JSON.stringify({ files: config.files, features: config.features.map(({ key, options }) => ({ key, options })) });
    expect(json).toContain('"signingSecret":"[secret]"');
    expect(json).toContain('"token":"[secret]"');
    expect(json).not.toContain(SECRET);
    expect(Bun.inspect(config.files)).not.toContain(SECRET);
    expect(Bun.inspect(config.features[0]!.options)).not.toContain(SECRET);
    const fromEnv = resolveConfig({ database: memoryAdapter() }, { FILES_SIGNING_SECRET: SECRET });
    expect(JSON.stringify(fromEnv.files)).not.toContain(SECRET);
  });
});
