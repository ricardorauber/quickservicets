import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, resolveConfig, type ServiceConfig } from "./config.ts";
import { CONFIG_OVERRIDES, envNameFor, logConfigWarnings, NOT_OVERRIDABLE } from "./environment.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import type { LogEntry } from "./logger.ts";
import { integer, object, secret, string } from "./options.ts";
import { resolveOption } from "./options.ts";

const audit = defineFeature({ docs: { summary: "Test native." },
  key: "audit",
  options: object({ greeting: string().perRequest().default("Hello"), level: integer().default(1), token: secret().optional() }),
});

afterEach(() => unregisterNative("audit"));

// The default security native is off, so the feature lists hold only the test natives.
const resolve = (env: Record<string, string>, config: Record<string, unknown> = {}) => resolveConfig({ database: memoryAdapter(), security: false, ...config } as ServiceConfig, env);
const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("naming", () => {
  test("QS_ plus the path in upper snake case", () => {
    expect(envNameFor("server.port")).toBe("QS_SERVER_PORT");
    expect(envNameFor("jobs.limits.logLines")).toBe("QS_JOBS_LIMITS_LOG_LINES");
    expect(envNameFor("history.retention")).toBe("QS_HISTORY_RETENTION");
    expect(envNameFor("rate-limits.window")).toBe("QS_RATE_LIMITS_WINDOW");
    expect(envNameFor("repositories.toArrayMax")).toBe("QS_REPOSITORIES_TO_ARRAY_MAX");
    expect(envNameFor("server.publicUrl")).toBe("QS_SERVER_PUBLIC_URL");
  });

  test("two options that map to one variable make defineFeature throw", () => {
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", options: object({ fooBar: string(), foo: object({ bar: string() }) }) })).message).toBe(
      "Invalid feature x: options x.fooBar and x.foo.bar both map to QS_X_FOO_BAR",
    );
  });
});

/** The paths of `ServiceConfig` leaves (keys that are not nested objects), read from its declaration. */
function scalarConfigPaths(source: string): string[] {
  const file = ts.createSourceFile("config.ts", source, ts.ScriptTarget.ESNext, true);
  const config = file.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === "ServiceConfig");
  const paths: string[] = [];
  const visit = (members: ts.NodeArray<ts.TypeElement>, prefix: string) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const path = `${prefix}${member.name.getText(file)}`;
      if (ts.isTypeLiteralNode(member.type)) visit(member.type.members, `${path}.`);
      else paths.push(path);
    }
  };
  visit(config!.members, "");
  return paths;
}
const missingDescriptors = (source: string) =>
  scalarConfigPaths(source).filter((path) => !CONFIG_OVERRIDES.some((override) => override.path === path) && !NOT_OVERRIDABLE.includes(path));

describe("descriptors", () => {
  const source = readFileSync(join(import.meta.dir, "config.ts"), "utf8");

  test("every scalar key of ServiceConfig has a descriptor or is not overridable", () => {
    expect(missingDescriptors(source)).toEqual([]);
    expect(CONFIG_OVERRIDES.map((override) => override.path).filter((path) => !scalarConfigPaths(source).includes(path))).toEqual([]);
  });

  test("a new scalar key without a descriptor is reported", () => {
    const added = source.replace("  /** Repository settings. */", "  /** A new key. */\n  newKey?: string;\n  /** Repository settings. */");
    expect(missingDescriptors(added)).toEqual(["newKey"]);
  });

  test("keys holding behavior are not overridable", () => {
    expect(NOT_OVERRIDABLE).toEqual(["database", "logger", "storage", "plugins", "middleware", "env", "docs.openapi"]);
    const database = memoryAdapter();
    expect(resolveConfig({ database }, { QS_DATABASE: "x" }).database).toBe(database);
  });
});

describe("overrides", () => {
  test("variables set core keys, parsed from text", () => {
    const resolved = resolve({ QS_SERVER_PORT: "4000", QS_JOBS_RETRIES: "2", QS_FILES_ACCEPT: "image/*, application/pdf", QS_DOCS_ENABLED: "false" });
    expect(resolved.server.port).toBe(4000);
    expect(resolved.jobs.retries).toBe(2);
    expect(resolved.files.accept).toEqual(["image/*", "application/pdf"]);
    expect(resolved.docs.enabled).toBe(false);
    expect(resolve({ QS_JOBS_LIMITS_LOG_LINES: "20", QS_FILES_MAX_SIZE: "1MB" }).jobs.limits.logLines).toBe(20);
    expect(resolve({ QS_FILES_MAX_SIZE: "1MB" }).files.maxSize).toBe(1024 * 1024);
  });

  test("variable > alias > config value > default", () => {
    expect(resolve({}).server.port).toBe(3000);
    expect(resolve({}, { server: { port: 3001 } }).server.port).toBe(3001);
    expect(resolve({ PORT: "4000" }, { server: { port: 3001 } }).server.port).toBe(4000);
    expect(resolve({ PORT: "4000", QS_SERVER_PORT: "5000" }, { server: { port: 3001 } }).server.port).toBe(5000);
    expect(resolve({ NODE_ENV: "production" }).production).toBe(true);
    expect(resolve({ NODE_ENV: "development" }, { production: true }).production).toBe(true);
    expect(resolve({ NODE_ENV: "production", QS_PRODUCTION: "false" }).production).toBe(false);
    expect(resolve({ JOBS_ENABLED: "false" }).jobs.enabled).toBe(false);
    expect(resolve({ JOBS_ENABLED: "false", QS_JOBS_ENABLED: "true" }).jobs.enabled).toBe(true);
    expect(resolve({ FILES_SIGNING_SECRET: "a" }, { files: { signingSecret: "b" } }).files.signingSecret).toBe("a");
    expect(resolve({ FILES_SIGNING_SECRET: "a", QS_FILES_SIGNING_SECRET: "c" }).files.signingSecret).toBe("c");
    expect(resolve({ DATABASE_SCHEMA: "tenant-a" }).schema).toBe("tenant-a");
    expect(resolve({ DATABASE_SCHEMA: "tenant-a", QS_SCHEMA: "tenant-b" }).schema).toBe("tenant-b");
    expect(resolve({ PORT: "" }, { server: { port: 3001 } }).server.port).toBe(3001);
  });

  test("the config passed in is never changed", () => {
    const config: ServiceConfig = { database: memoryAdapter(), server: { port: 3001 }, jobs: { retries: 1 } };
    resolveConfig(config, { QS_SERVER_PORT: "4000", QS_JOBS_RETRIES: "3" });
    expect(config.server).toEqual({ port: 3001 });
    expect(config.jobs).toEqual({ retries: 1 });
  });

  test("invalid variables name the variable and the key, all at once, with secrets masked", () => {
    expect(failure(() => resolve({ QS_SERVER_PORT: "abc" })).message).toBe('Invalid QS_SERVER_PORT (server.port): expected an integer between 1 and 65535, got "abc"');
    expect(failure(() => resolve({ PORT: "abc" })).message).toBe('Invalid PORT (server.port): expected an integer between 1 and 65535, got "abc"');
    const error = failure(() => resolve({ QS_SERVER_PORT: "0", QS_JOBS_TIMEOUT: "soon" }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.split("\n")).toHaveLength(2);
    registerNative(audit);
    expect(failure(() => resolve({ QS_AUDIT_TOKEN: "x", QS_AUDIT_LEVEL: "high" }, { audit: {} })).message).toBe(
      'Invalid QS_AUDIT_LEVEL (audit.level): expected an integer, got "high"',
    );
    const masked = defineFeature({ docs: { summary: "Test native." }, key: "vault", options: object({ token: secret().min(8) }) });
    registerNative(masked);
    try {
      const message = failure(() => resolve({ QS_VAULT_TOKEN: "short" }, { vault: {} } as never)).message;
      expect(message).toBe("Invalid QS_VAULT_TOKEN (vault.token): expected a string of at least 8 characters, got [secret]");
    } finally {
      unregisterNative("vault");
    }
  });

  test("server.workers keeps its own variables, with QS_SERVER_WORKERS first", () => {
    const postgres = { kind: "postgres" } as never;
    expect(resolveConfig({ database: postgres }, { QS_SERVER_WORKERS: "3", QS_WORKERS: "2" }).server.workers).toBe(3);
    expect(resolveConfig({ database: postgres }, { QS_WORKERS: "2" }).server.workers).toBe(2);
    expect(failure(() => resolveConfig({ database: postgres }, { QS_SERVER_WORKERS: "0" })).message).toBe(
      'Invalid QS_SERVER_WORKERS (server.workers): expected a positive integer or "auto", got "0"',
    );
  });
});

describe("feature options", () => {
  test("a variable replaces an option, a per-request function included", async () => {
    registerNative(audit);
    const config = { audit: { greeting: () => "from code" } };
    const fromCode = resolve({}, config).features[0]!.options.greeting;
    expect(await resolveOption(fromCode as () => string, {})).toBe("from code");
    const resolved = resolve({ QS_AUDIT_GREETING: "Hi", QS_AUDIT_LEVEL: "3" }, config);
    expect(resolved.features[0]!.options).toEqual({ greeting: "Hi", level: 3, enabled: true });
  });

  test("QS_<KEY>_ENABLED turns a native on without its key, and off with it", () => {
    registerNative(audit);
    expect(resolve({ QS_AUDIT_ENABLED: "true" }).features.map(({ key, options }) => [key, options])).toEqual([["audit", { greeting: "Hello", level: 1, enabled: true }]]);
    expect(resolve({ QS_AUDIT_ENABLED: "false" }, { audit: { level: 2 } }).features).toEqual([]);
    expect(resolve({ QS_AUDIT_ENABLED: "true" }, { audit: false }).features).toHaveLength(1);
    expect(resolve({ QS_AUDIT_ENABLED: "true" }, { audit: { enabled: false, level: 2 } }).features[0]!.options.level).toBe(2);
  });

  test("option variables alone do not turn a feature on", () => {
    registerNative(audit);
    expect(resolve({ QS_AUDIT_LEVEL: "3" }).features).toEqual([]);
    expect(resolve({ QS_AUDIT_LEVEL: "3", QS_AUDIT_ENABLED: "1" }).features[0]!.options.level).toBe(3);
  });
});

describe("unknown variables", () => {
  test("an unknown QS_ variable is a warning with the closest name", () => {
    expect(resolve({ QS_SERVR_PORT: "1" }).warnings).toEqual(["Unknown environment variable QS_SERVR_PORT (did you mean QS_SERVER_PORT?)"]);
    expect(resolve({ QS_SOMETHING_ELSE: "1" }).warnings).toEqual(["Unknown environment variable QS_SOMETHING_ELSE"]);
    expect(resolve({ QS_SERVER_PORT: "4000", QS_WORKERS: "1", QS_WORKER_INDEX: "0", OTHER: "x" }).warnings).toEqual([]);
    registerNative(audit);
    expect(resolve({ QS_AUDIT_LEVLE: "3" }).warnings).toEqual(["Unknown environment variable QS_AUDIT_LEVLE (did you mean QS_AUDIT_LEVEL?)"]);
  });

  test("warnings are logged once, outside the worker processes", () => {
    const entries: LogEntry[] = [];
    const logger = { info() {}, warn: (entry: LogEntry) => entries.push(entry), error() {} };
    const config = { warnings: ["Unknown environment variable QS_X"], logger };
    logConfigWarnings(config, {});
    logConfigWarnings(config, { QS_WORKER_INDEX: "1" });
    expect(entries).toEqual([expect.objectContaining({ message: "config.warning", warning: "Unknown environment variable QS_X" })]);
  });
});
