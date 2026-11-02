import "./index.ts";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:tls";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { env } from "./env-vars.ts";
import { defineFeature, registerProjectFeatures, type FeatureDefinition } from "./features.ts";
import { dueTime, events, http, refreshSecrets, setSecretsClock, type SecretProvider, type SecretRotation } from "./index.ts";
import { mockHttp } from "./features/http/mock.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry, Logger } from "./logger.ts";
import { object, secret } from "./options.ts";
import { secrets } from "./secret-references.ts";
import { startService, type RunningService } from "./service.ts";
import { createTestCertificates } from "./testing/certificates.ts";

let now = Date.parse("2026-11-02T10:00:00.000Z");
const advance = (ms: number) => void (now += ms);
setSecretsClock(() => now);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  registerProjectFeatures([]);
});

const captured = () => {
  const entries: LogEntry[] = [];
  const logger: Logger = { info: (entry) => void entries.push(entry), warn: (entry) => void entries.push({ ...entry, level: "warn" }), error: (entry) => void entries.push({ ...entry, level: "error" }), debug: () => {} };
  return { entries, logger };
};

/** A provider for `test://` whose values change with `set`, failing with `fail`, counting its calls. */
function versioned(initial: Record<string, string>, extra: { ttl?: number; expiresIn?: number } = {}) {
  const values = new Map(Object.entries(initial));
  const versions = new Map<string, number>();
  const failing = new Set<string>();
  const calls: string[] = [];
  const provider: SecretProvider = {
    schemes: ["test"],
    resolve(reference) {
      calls.push(reference.text);
      if (failing.has(reference.path)) throw new Error("vault unavailable");
      const value = values.get(reference.path);
      if (value === undefined) throw new Error(`${reference.text}: not found`);
      return {
        value,
        version: String(versions.get(reference.path) ?? 1),
        ...(extra.ttl !== undefined ? { ttl: extra.ttl } : {}),
        ...(extra.expiresIn !== undefined ? { expiresAt: now + extra.expiresIn } : {}),
      };
    },
  };
  return {
    provider,
    calls,
    set(path: string, value: string) {
      values.set(path, value);
      versions.set(path, (versions.get(path) ?? 1) + 1);
    },
    fail: (path: string) => void failing.add(path),
    heal: (path: string) => void failing.delete(path),
  };
}

const providerFeature = (provider: SecretProvider) =>
  defineFeature({ key: "vault-test", enabledByDefault: true, requires: ["secrets"], setup: (ctx) => ctx.feature("secrets").provider(provider) });

/** Starts the features and an app (not listening), as a service does, with the logs captured. */
async function start(config: ServiceConfig, environment: Record<string, string> = {}, features: FeatureDefinition[] = []) {
  registerProjectFeatures(features.map((definition) => ({ folder: definition.key, definition })));
  const { entries, logger } = captured();
  const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config }, environment);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await resolved.database.connect([]);
  const app = createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config: resolved, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  stops.push(async () => {
    await lifecycle.shutdown();
    await app.shutdown();
    await lifecycle.stop();
    await resolved.database.disconnect();
  });
  return { config: resolved, app, entries, fetch: (path: string) => app.server.fetch(new Request(`http://localhost${path}`)) };
}

const billing = defineFeature({ key: "billing", options: object({ token: secret() }) });
const optionsOf = (config: { features: { key: string; options: unknown }[] }, key: string) => config.features.find((feature) => feature.key === key)!.options as Record<string, unknown>;

describe("due times from ttl and expiresAt", () => {
  test("a value is due at its ttl, at two thirds of its lease, or at the default ttl", () => {
    expect(dueTime(0, 900_000, {})).toBe(900_000);
    expect(dueTime(0, 900_000, { ttl: 60_000 })).toBe(60_000);
    expect(dueTime(0, 900_000, { ttl: "2m" })).toBe(120_000);
    expect(dueTime(0, 900_000, { expiresAt: 90_000 })).toBe(60_000);
    expect(dueTime(0, 900_000, { ttl: 30_000, expiresAt: 90_000 })).toBe(30_000);
  });

  test("a value with expiresAt in 90 seconds is re-resolved after 60 seconds", async () => {
    const vault = versioned({ api: "lease-value-1" }, { expiresIn: 90_000 });
    await start({ secrets: {}, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider)]);
    advance(59_000);
    await refreshSecrets();
    expect(vault.calls.length).toBe(1);
    advance(1_000);
    await refreshSecrets();
    expect(vault.calls.length).toBe(2);
  });
});

describe("the refresh loop and in-place updates", () => {
  test("a rotated value reaches the feature options and env after its ttl, with a log entry and the hooks", async () => {
    const vault = versioned({ api: "token-version-1", key: "env-key-version-1" }, { ttl: 60_000 });
    const rotations: SecretRotation[] = [];
    const { config, entries } = await start(
      { secrets: { onRotate: (rotation: SecretRotation) => void rotations.push(rotation) }, billing: { token: secret("test://api") }, env: { PARTNER_KEY: secret() } } as ServiceConfig,
      { PARTNER_KEY: "test://key" },
      [billing, providerFeature(vault.provider)],
    );
    expect(optionsOf(config, "billing").token).toBe("token-version-1");
    vault.set("api", "token-version-2");
    vault.set("key", "env-key-version-2");
    advance(30_000);
    await refreshSecrets();
    expect(optionsOf(config, "billing").token).toBe("token-version-1");
    advance(30_000);
    await refreshSecrets();
    expect(optionsOf(config, "billing").token).toBe("token-version-2");
    expect((env as Record<string, unknown>).PARTNER_KEY).toBe("env-key-version-2");
    expect(entries.filter((entry) => entry.message === "secrets.rotated").map((entry) => [entry.path, entry.version])).toEqual([
      ["billing.token", "2"],
      ["env.PARTNER_KEY", "2"],
    ]);
    expect(rotations).toEqual([
      { path: "billing.token", reference: "test://api", version: "2" },
      { path: "env.PARTNER_KEY", reference: "test://key", version: "2" },
    ]);
    expect(JSON.stringify(rotations)).not.toContain("version-2");
  });

  test("checks run in the background every refresh interval once the service started", async () => {
    setSecretsClock(undefined);
    try {
      const vault = versioned({ api: "fast-token-1" }, { ttl: 0 });
      const { config } = await start({ secrets: { refresh: "20ms" }, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider)]);
      vault.set("api", "fast-token-2");
      for (let i = 0; i < 100 && optionsOf(config, "billing").token !== "fast-token-2"; i++) await Bun.sleep(10);
      expect(optionsOf(config, "billing").token).toBe("fast-token-2");
    } finally {
      setSecretsClock(() => now);
    }
  });
});

describe("hooks, event and logging without values", () => {
  test("secret.rotated is emitted while events is on, with the path, the reference and the version", async () => {
    const vault = versioned({ api: "evented-token-1" }, { ttl: 1_000 });
    const seen: unknown[] = [];
    await start({ secrets: {}, events: {}, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider)]);
    const off = events.on("secret.rotated", (event) => void seen.push(event));
    try {
      vault.set("api", "evented-token-2");
      advance(1_000);
      await refreshSecrets();
      await events.idle();
      expect(JSON.stringify(seen)).toContain('"path":"billing.token"');
      expect(JSON.stringify(seen)).toContain('"reference":"test://api"');
      expect(JSON.stringify(seen)).not.toContain("evented-token");
    } finally {
      off();
    }
  });
});

describe("consumers reading at use time", () => {
  test("rotating a service's bearer token makes the next call send the new token", async () => {
    const vault = versioned({ billing: "bearer-token-1" }, { ttl: 1_000 });
    const mock = mockHttp();
    try {
      const seen: (string | null)[] = [];
      mock.on("GET", "https://billing.example.com/invoices").replyWith((request) => {
        seen.push(request.headers.get("authorization"));
        return { status: 200, body: [] };
      });
      await start({ secrets: {}, http: { services: { billing: { url: "https://billing.example.com", auth: { bearer: secret("test://billing") } } } } } as ServiceConfig, {}, [providerFeature(vault.provider)]);
      await http.service("billing" as never).get("/invoices").response();
      vault.set("billing", "bearer-token-2");
      advance(1_000);
      await refreshSecrets();
      await http.service("billing" as never).get("/invoices").response();
      expect(seen).toEqual(["Bearer bearer-token-1", "Bearer bearer-token-2"]);
    } finally {
      mock.restore();
    }
  });

  const pgUrl = process.env.TEST_POSTGRES_URL;
  test.skipIf(!pgUrl)("rotating PG_URL makes new PostgreSQL connections use it while open ones finish", async () => {
    const withName = (name: string) => {
      const url = new URL(pgUrl!);
      url.searchParams.set("application_name", name);
      return url.toString();
    };
    const environment: Record<string, string> = { PG_URL: withName("qs_rotation_one") };
    const adapter = postgresAdapter({ url: secret("env://PG_URL") });
    await start({ secrets: { ttl: "1s" }, database: adapter }, environment);
    const name = async () => ((await adapter.client!`select current_setting('application_name') as name`) as { name: string }[])[0]!.name;
    expect(await name()).toBe("qs_rotation_one");
    const open = adapter.client!`select pg_sleep(0.3), current_setting('application_name') as name`.execute();
    await Bun.sleep(50);
    environment.PG_URL = withName("qs_rotation_two");
    advance(1_000);
    await refreshSecrets();
    expect(await name()).toBe("qs_rotation_two");
    expect(((await open) as { name: string }[])[0]!.name).toBe("qs_rotation_one");
  });

  test("rotating the references behind server.tls.cert and key applies the new certificate to new connections", async () => {
    const certs = createTestCertificates();
    const environment: Record<string, string> = { TLS_CERT: certs.server.certPem, TLS_KEY: certs.server.keyPem };
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const { logger } = captured();
    const log = spyOn(console, "log").mockImplementation(() => {});
    let service: RunningService | undefined;
    try {
      service = await startService({
        projectConfig: { database: memoryAdapter(), logger, secrets: { ttl: "1s" }, server: { tls: { cert: secret("env://TLS_CERT"), key: secret("env://TLS_KEY"), reloadInterval: "1h" } } } as ServiceConfig,
        models: [],
        crudRoutes: [],
        endpoints: [],
        hooks: new Map(),
        env: { ...environment, QS_SERVER_PORT: String(port) },
        process: { once: () => {}, exit: () => {} } as never,
      });
    } finally {
      log.mockRestore();
    }
    stops.push(() => service!.stop());
    const served = () =>
      new Promise<string>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port, servername: "localhost", ca: certs.ca.certPem }, () => {
          resolve(String(socket.getPeerCertificate().subject.O));
          socket.end();
        });
        socket.on("error", (error: Error) => resolve(`error ${error.message}`));
      });
    expect(await served()).toBe("QuickService.ts Tests");
    // startService resolved with its own copy of the environment; the env provider reads the one it was given.
    const given = service!.config as unknown as { server: { tls: Record<string, unknown> } };
    expect(given.server.tls.cert).toBe(certs.server.certPem);
    const { secretEnvironment } = await import("./secret-references.ts");
    Object.assign(secretEnvironment(), { TLS_CERT: certs.server2.certPem, TLS_KEY: certs.server2.keyPem });
    advance(1_000);
    await refreshSecrets();
    expect(await served()).toBe("QuickService.ts Tests 2");
  });
});

describe("failures, expiry, the health check and secrets.get", () => {
  test("a failing refresh keeps the value and logs once a minute; an expired lease logs secrets.expired", async () => {
    const vault = versioned({ api: "kept-token-1" }, { ttl: 10_000, expiresIn: 90_000 });
    const { config, entries } = await start({ secrets: { retries: 0 }, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider)]);
    vault.fail("api");
    advance(10_000);
    await refreshSecrets();
    advance(30_000);
    await refreshSecrets();
    expect(optionsOf(config, "billing").token).toBe("kept-token-1");
    expect(entries.filter((entry) => entry.message === "secrets.refresh.failed")).toEqual([expect.objectContaining({ path: "billing.token", reason: "vault unavailable" })]);
    advance(31_000);
    await refreshSecrets();
    expect(entries.filter((entry) => entry.message === "secrets.refresh.failed").length).toBe(2);
    expect(vault.calls.length).toBe(4);
    advance(20_000);
    await refreshSecrets();
    expect(entries.find((entry) => entry.message === "secrets.expired")).toMatchObject({ path: "billing.token", level: "error" });
  });

  test("with onRefreshError fail, /health/ready answers 503 with the secrets check failing; with keep it degrades", async () => {
    for (const mode of ["fail", "keep"] as const) {
      const vault = versioned({ api: `health-token-${mode}` }, { ttl: 1_000 });
      const { fetch } = await start({ secrets: { retries: 0, onRefreshError: mode }, health: { cache: "0s", details: true }, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider)]);
      expect((await fetch("/health/ready")).status).toBe(200);
      vault.fail("api");
      advance(1_000);
      await refreshSecrets();
      const response = await fetch("/health/ready");
      const body = (await response.json()) as { checks: Record<string, { status: string; error?: string }> };
      expect(response.status).toBe(mode === "fail" ? 503 : 200);
      expect(body.checks.secrets).toMatchObject({ status: "fail", error: expect.stringContaining("billing.token") });
      expect(JSON.stringify(body)).not.toContain("health-token");
      for (const stop of stops.splice(0).reverse()) await stop();
    }
  });

  test("secrets.get resolves once within the ttl, and secrets.onRotate fires after a change", async () => {
    const vault = versioned({ partner: JSON.stringify({ key: "partner-key-1" }) }, { ttl: 60_000 });
    await start({ secrets: {} }, {}, [providerFeature(vault.provider)]);
    expect(await secrets.get("test://partner#key")).toBe("partner-key-1");
    expect(await Promise.all([secrets.get("test://partner#key"), secrets.get("test://partner#key")])).toEqual(["partner-key-1", "partner-key-1"]);
    expect(vault.calls).toEqual(["test://partner#key"]);
    const changes: string[] = [];
    secrets.onRotate("test://partner#key", (value) => void changes.push(value));
    vault.set("partner", JSON.stringify({ key: "partner-key-2" }));
    advance(60_000);
    await refreshSecrets();
    expect(changes).toEqual(["partner-key-2"]);
    expect(await secrets.get("test://partner#key")).toBe("partner-key-2");
  });

  test("secrets.get without the native fails naming the fix", async () => {
    await expect(secrets.get("test://x")).rejects.toThrow("secrets.get(test://x) needs the secrets native; add secrets: {} to quickservicets.config.ts");
  });

  test("both the old and the new value of a rotated secret are masked in later log entries", async () => {
    const vault = versioned({ api: "old-masked-token" }, { ttl: 1_000 });
    let featureLogger: Logger | undefined;
    const logs = defineFeature({ key: "audit-log", enabledByDefault: true, setup: (ctx) => void (featureLogger = ctx.logger) });
    const { entries } = await start({ secrets: {}, billing: { token: secret("test://api") } } as ServiceConfig, {}, [billing, providerFeature(vault.provider), logs]);
    vault.set("api", "new-masked-token");
    advance(1_000);
    await refreshSecrets();
    featureLogger!.info({ timestamp: new Date().toISOString(), message: "tokens", detail: "old-masked-token then new-masked-token" });
    expect(entries.find((entry) => entry.message === "tokens")!.detail).toBe("[secret] then [secret]");
  });
});
