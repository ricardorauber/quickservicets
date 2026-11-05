import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { boolean, defineFeature, duration, object, oneOf, onServiceStarted, onShutdownSignal, parseDuration, record, runHealthChecks, safeLog, string, systemClock, url, type JobClock, type Logger } from "../public.ts";
import { sharedState, type InstanceStatus, type RegistryProvider, type ServiceInstance } from "./provider.ts";

/** The public API of the `registry` native, `ctx.feature("registry")` in a feature that lists it in `requires`, `after` or `enables`. */
export interface RegistryApi {
  /** Replaces the configured provider, from the setup of another feature; two features setting one fail naming both. */
  setProvider(provider: RegistryProvider): void;
  /** The provider in effect, once every setup ran. */
  provider(): RegistryProvider;
  /** This process's instance, as it registers. */
  instance(): ServiceInstance;
}

/** The provider a feature set, with who set it. */
const chosen = sharedState("provider", () => ({ choice: undefined as { provider: RegistryProvider; owner: string } | undefined, current: undefined as RegistryProvider | undefined }));

/** This process's instance, once the native's setup built it. */
const self = sharedState("self", () => ({ instance: undefined as ServiceInstance | undefined }));

/** The clock of heartbeats and retries; tests set a fake one. */
const clocks = sharedState("clock", () => ({ current: systemClock as JobClock }));

/** Sets the clock of heartbeats and registration retries (default: the system clock), for tests. */
export function setRegistryClock(clock: JobClock = systemClock): void {
  clocks.current = clock;
}

/** The provider of the running service; undefined while the native does not run. */
export function currentRegistryProvider(): RegistryProvider | undefined {
  return chosen.current;
}

/** The built-in `static` provider: instances come from the config, and registering does nothing. */
export function staticProvider(): RegistryProvider {
  return { register() {}, heartbeat() {}, deregister() {}, resolve: () => [] };
}

const options = object({
  name: string().optional().describe("The service name the instance registers under (default: deploy.name, then the package name without its scope)."),
  version: string().optional().describe("The version the instance announces (default: the package version)."),
  address: url().optional().describe("The base URL other services call the instance at (default: http with the machine's first non-loopback address and the server port)."),
  metadata: record(string().describe("A metadata value.")).describe("Metadata the instance registers with, like a region or a build number."),
  zone: string().optional().describe("The zone the instance runs in, preferred by callers in the same zone."),
  provider: oneOf(["static", "dns"] as const).default("static").describe("The built-in provider: static (instances listed in the config; registering does nothing) or dns (instances from DNS records)."),
  register: boolean().default(true).describe("Registers the instance once it started, keeps it alive with heartbeats and deregisters it on shutdown."),
  heartbeat: duration().default("10s").describe("How often the instance's entry is renewed with its status."),
  ttl: duration().default("30s").describe("How long a registry keeps the entry without a heartbeat."),
});

/** The resolved options of the `registry` native. */
export interface RegistryOptions {
  name?: string;
  version?: string;
  address?: string;
  metadata: Record<string, string>;
  zone?: string;
  provider: "static" | "dns" | RegistryProvider;
  register: boolean;
  heartbeat: string;
  ttl: string;
}

/** The project's package.json in the working directory, for the default name and version. */
function projectPackage(): { name?: string; version?: string } {
  const file = join(process.cwd(), "package.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
  } catch {
    return {};
  }
}

/** The first non-loopback IPv4 address of the machine (then IPv6), or `127.0.0.1` without one. */
export function firstAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  const all = Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal);
  const v4 = all.find((entry) => entry.family === "IPv4");
  if (v4) return v4.address;
  const v6 = all.find((entry) => entry.family === "IPv6");
  return v6 ? `[${v6.address}]` : "127.0.0.1";
}

/** The readiness of the health native as an instance status: ok is passing, degraded warning and fail critical. */
export const statusOfReadiness = (status: string): InstanceStatus => (status === "ok" ? "passing" : status === "degraded" ? "warning" : "critical");

/** The longest delay between two registration attempts. */
export const MAX_REGISTER_RETRY_MS = 30_000;

/**
 * The instance this process registers: its name, version, address, zone and metadata, with the id
 * `<name>-<hostname>-<pid>`.
 */
export function ownInstance(options: Pick<RegistryOptions, "name" | "version" | "address" | "metadata" | "zone">, defaults: { name: string; version?: string; port: number }): ServiceInstance {
  const name = options.name ?? defaults.name;
  return {
    id: `${name}-${hostname()}-${process.pid}`,
    name,
    ...((options.version ?? defaults.version) !== undefined ? { version: options.version ?? defaults.version } : {}),
    address: (options.address ?? `http://${firstAddress()}:${defaults.port}`).replace(/\/+$/, ""),
    status: "passing",
    ...(options.zone !== undefined ? { zone: options.zone } : {}),
    metadata: { ...options.metadata },
  };
}

/** Runs one provider call, logging `registry.<step>.failed` with the provider and the reason; resolves whether it worked. */
async function attempt(logger: Logger, step: "register" | "heartbeat" | "deregister", provider: string, fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: `registry.${step}.failed`, provider, reason: (error as Error)?.message ?? String(error) });
    return false;
  }
}

/**
 * The `registry` native: each instance announces itself to a service registry once it is ready (name, version,
 * address, status and metadata), keeps its entry alive with heartbeats and leaves before it stops serving. Off unless
 * `registry: {}` (or `QS_REGISTRY_ENABLED=true`) is set.
 */
export const registryFeature = defineFeature({
  key: "registry",
  docs: {
    summary: "Service registration and discovery: instances register when ready, keep their entry alive with heartbeats and leave before they stop serving.",
    sections: [
      {
        title: "Registration",
        text: [
          "With `register: true`, the worker that runs scheduled work registers the instance after every `onStart` callback ran (once per process, whatever `server.workers`), sends a heartbeat every `heartbeat` with `passing` (or, while `health` is enabled, the readiness: `passing` for ok, `warning` for degraded, `critical` for fail), and deregisters as soon as the shutdown signal arrives, before draining, so callers stop sending traffic first.",
          "",
          "The instance is `{ id, name, version?, address, status, zone?, metadata }`, with the id `<name>-<hostname>-<pid>`; `name` defaults to `deploy.name` or the package name, `version` to the package version, and `address` to `http://<first non-loopback address>:<port>`.",
          "",
          "A failed registration, heartbeat or deregistration logs `registry.register.failed`, `registry.heartbeat.failed` or `registry.deregister.failed` with the provider and the reason; registration is retried with a delay from 1 second doubling to 30 seconds, and nothing fails startup or shutdown. While `health` is enabled, the non-critical check `registry` fails while the instance is not registered or its last heartbeat failed, with the provider's `health()` when it has one.",
        ].join("\n"),
      },
      {
        title: "Providers",
        text: [
          "A `RegistryProvider` has `register(instance)`, `heartbeat(instance, status)`, `deregister(instance)` and `resolve(name)` resolving `ServiceInstance[]`, plus the optional `watch(name, onChange)`, `health()` and `close()`. A feature listing `registry` in `requires`, `after` or `enables` sets one during its setup with `ctx.feature(\"registry\").setProvider(provider)`, replacing `provider`; two features setting one fail startup naming both.",
        ].join("\n"),
      },
    ],
  },
  options,
  after: ["health"],
  setup(ctx) {
    const resolved = ctx.options as unknown as RegistryOptions;
    chosen.choice = undefined;
    chosen.current = undefined;
    const pkg = projectPackage();
    const deployName = (ctx.config.features.find((feature) => feature.key === "deploy")?.options as { name?: string } | undefined)?.name;
    const instance = ownInstance(resolved, { name: deployName ?? (pkg.name ?? "service").replace(/^@[^/]+\//, ""), ...(pkg.version ? { version: pkg.version } : {}), port: ctx.config.server.port });
    self.instance = instance;
    const builtIn = (): RegistryProvider => staticProvider();
    const providerOf = (): RegistryProvider => (chosen.current ??= chosen.choice?.provider ?? builtIn());
    const providerName = () => chosen.choice?.owner ?? (typeof resolved.provider === "string" ? resolved.provider : "custom");
    const state = { registered: false, heartbeatOk: true, stopped: false, timer: undefined as unknown };
    const clock = () => clocks.current;
    const healthOn = ctx.config.features.some((feature) => feature.key === "health");
    if (healthOn) {
      ctx.feature("health").check(
        "registry",
        async () => {
          if (!state.registered) throw new Error("The instance is not registered");
          if (!state.heartbeatOk) throw new Error("The last heartbeat failed");
          const health = providerOf().health;
          return health ? await health.call(providerOf()) : undefined;
        },
        { critical: false },
      );
    }
    ctx.app.onStart(() => void providerOf());
    if (!resolved.register || !ctx.worker.runsScheduledWork) return;
    const schedule = (ms: number, fn: () => void) => {
      if (state.stopped) return;
      state.timer = clock().setTimeout(() => {
        state.timer = undefined;
        fn();
      }, ms);
    };
    const heartbeatMs = parseDuration(resolved.heartbeat) ?? 10_000;
    const statusNow = async (): Promise<InstanceStatus> => {
      if (!healthOn) return "passing";
      try {
        return statusOfReadiness((await runHealthChecks()).status);
      } catch {
        return "critical";
      }
    };
    const beat = async () => {
      if (state.stopped) return;
      const status = await statusNow();
      instance.status = status;
      state.heartbeatOk = await attempt(ctx.logger, "heartbeat", providerName(), () => providerOf().heartbeat(instance, status));
      schedule(heartbeatMs, () => void beat());
    };
    let retry = 1000;
    const register = async () => {
      if (state.stopped) return;
      if (await attempt(ctx.logger, "register", providerName(), () => providerOf().register(instance))) {
        state.registered = true;
        safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "registry.registered", provider: providerName(), instance: instance.id, address: instance.address });
        schedule(heartbeatMs, () => void beat());
        return;
      }
      const wait = retry;
      retry = Math.min(retry * 2, MAX_REGISTER_RETRY_MS);
      schedule(wait, () => void register());
    };
    const cancel = () => {
      state.stopped = true;
      if (state.timer !== undefined) clock().clearTimeout(state.timer);
      state.timer = undefined;
    };
    const deregister = async () => {
      const wasRegistered = state.registered;
      cancel();
      if (!wasRegistered) return;
      state.registered = false;
      await attempt(ctx.logger, "deregister", providerName(), () => providerOf().deregister(instance));
    };
    // Registration waits for every onStart; deregistration comes first on shutdown, before the ready route drains.
    let deregistering: Promise<void> | undefined;
    const listeners: (() => void)[] = [];
    // Listened to from onStart, so a service whose setup failed leaves no listener behind.
    ctx.app.onStart(() => {
      listeners.push(onServiceStarted(() => void register()), onShutdownSignal(() => void (deregistering ??= deregister()), { first: true }));
    });
    ctx.app.onStop(async () => {
      for (const off of listeners.splice(0)) off();
      await (deregistering ??= deregister());
      await chosen.current?.close?.();
      chosen.current = undefined;
    });
  },
  api: (ctx): RegistryApi => ({
    setProvider(provider) {
      const caller = ctx.currentFeature();
      if (!caller || caller === "registry") throw new Error("setProvider is only available during the setup of another feature");
      const missing = ["register", "heartbeat", "deregister", "resolve"].filter((method) => typeof (provider as unknown as Record<string, unknown>)?.[method] !== "function");
      if (missing.length > 0) throw new Error(`Invalid registry provider set by ${caller}: the RegistryProvider is missing ${missing.join(", ")}`);
      if (chosen.choice) throw new Error(`Registry provider set by ${chosen.choice.owner} and ${caller}; keep one`);
      chosen.choice = { provider, owner: caller };
    },
    provider: () => chosen.current ?? chosen.choice?.provider ?? staticProvider(),
    instance: () => {
      if (!self.instance) throw new Error("registry instance() is available once the native's setup ran");
      return self.instance;
    },
  }),
});

export default registryFeature;
export { sharedState } from "./provider.ts";
export type { InstanceStatus, RegistryProvider, ServiceInstance } from "./provider.ts";
