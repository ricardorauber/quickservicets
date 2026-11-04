import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeYaml, INFRA_CATALOG, isInfraKind, parseDuration, resolveInfraEnv, resolveInfraTemplate, spawnExec, type Exec, type InfraEndpoint, type InfraService } from "@quickservicets/core";

/** The label every test container carries, so leftovers can be found and removed. */
export const TEST_CONTAINER_LABEL = "quickservicets.test";

/** Services started for tests: their connection variables, one URL per name, and how to stop them. */
export interface TestServices {
  /** The connection variables of every service, resolved with the mapped ports (like `DATABASE_URL`). */
  env: Record<string, string>;
  /** The main connection URL of each service, by the name it was asked for. */
  urls: Record<string, string>;
  /** The compose project of the containers (`qs-test-<random>`), or undefined when every service is an existing one. */
  project?: string;
  /** Removes the containers and their volumes; with `reuse`, only after the last user stops. */
  stop(): Promise<void>;
}

/** What `startServices` accepts. */
export interface StartServicesOptions {
  /** Shares one set of containers between calls with the same names in this process (default false). */
  reuse?: boolean;
  /** How long the health checks may take (default `"90s"`). */
  timeout?: string;
  /**
   * The services of the project's infrastructure description, so requirement names (like `database` or `redis`) can
   * be asked for besides catalog kinds.
   */
  services?: readonly InfraService[];
  /** The environment read for `TEST_<KIND>_URL` and given to Docker (default: the process's). */
  env?: Record<string, string | undefined>;
  /** Runs Docker (default: `Bun.spawn`). */
  exec?: Exec;
}

/** The variable that points a kind at an existing service: `postgres` is `TEST_POSTGRES_URL`. */
export const testServiceVariable = (kind: string) => `TEST_${kind.replaceAll("-", "_").toUpperCase()}_URL`;

/** A catalog kind as a service of its own, named after the kind. */
function catalogService(kind: string): InfraService {
  if (!isInfraKind(kind)) throw new Error(`Unknown service ${kind}; use a catalog kind (${Object.keys(INFRA_CATALOG).join(", ")}) or a requirement of the project`);
  const entry = INFRA_CATALOG[kind];
  return {
    name: kind,
    kind,
    description: entry.description,
    image: entry.image,
    ports: [...entry.ports],
    health: entry.health,
    credentials: { ...entry.credentials },
    environment: { ...entry.environment },
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.data ? { data: entry.data } : {}),
    env: { ...entry.templates },
    optional: false,
    owners: [kind],
  };
}

/** The service a name asks for: a requirement of the project's description, or a catalog kind. */
function serviceNamed(name: string, project: readonly InfraService[]): InfraService {
  return project.find((service) => service.name === name) ?? catalogService(name);
}

/** The endpoint an existing service's URL describes: its host, its port for every container port and its credentials. */
function endpointOfUrl(url: string, service: InfraService): InfraEndpoint {
  const parsed = new URL(url);
  const port = Number(parsed.port) || service.ports[0]!;
  const database = parsed.pathname.replace(/^\//, "");
  return {
    host: parsed.hostname,
    ports: Object.fromEntries(service.ports.map((container, index) => [container, index === 0 ? port : container])),
    credentials: {
      ...(parsed.username ? { user: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
      ...(database ? { database } : {}),
    },
  };
}

/** One running compose project of the test process. */
interface RunningProject {
  project: string;
  file: string;
  dir: string;
  users: number;
  started: Promise<TestServices>;
}

/** The compose projects this process started and has not stopped, by project name. */
const running = new Map<string, RunningProject>();
/** The projects shared with `reuse`, by their sorted names. */
const reused = new Map<string, RunningProject>();
let exitHandlers = false;

/** The state file the reaper reads: one line per running project. */
let stateFile: string | undefined;

/** Lists the running projects for the reaper. */
function writeState(): void {
  if (!stateFile) return;
  writeFileSync(stateFile, [...running.values()].map((entry) => JSON.stringify({ project: entry.project, file: entry.file, dir: entry.dir })).join("\n"));
}

/**
 * Starts the reaper once per process: `bun test` runs no exit handlers, so a small script beside the test process
 * removes the containers it left once it is gone.
 */
function startReaper(): void {
  if (stateFile) return;
  stateFile = join(mkdtempSync(join(tmpdir(), "qs-test-reaper-")), "projects.jsonl");
  writeFileSync(stateFile, "");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "reaper.ts"), String(process.pid), stateFile], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

/** Stops every test project this process still runs, synchronously; runs as the process exits or gets SIGINT or SIGTERM. */
export function stopTestServicesNow(): void {
  for (const entry of running.values()) {
    try {
      Bun.spawnSync(["docker", "compose", "-f", entry.file, "-p", entry.project, "down", "--volumes", "--timeout", "1"], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // Docker went away; nothing is left to stop.
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
  running.clear();
  reused.clear();
  writeState();
}

/** Stops the projects on exit and on SIGINT and SIGTERM, once per process. */
function installExitHandlers(): void {
  if (exitHandlers) return;
  exitHandlers = true;
  process.on("exit", stopTestServicesNow);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => {
      stopTestServicesNow();
      process.exit(code);
    });
  }
}

/** The compose document of test containers: every port published on a random loopback port, labeled, no named volumes. */
function testDocument(project: string, services: readonly InfraService[]) {
  return {
    name: project,
    services: Object.fromEntries(
      services.map((service) => [
        service.name,
        {
          image: service.image,
          ...(service.command ? { command: [...service.command] } : {}),
          ...(Object.keys(service.environment).length > 0 ? { environment: service.environment } : {}),
          ports: service.ports.map((port) => `127.0.0.1::${port}`),
          labels: { [TEST_CONTAINER_LABEL]: "true" },
          ...(service.health ? { healthcheck: { test: [...service.health], interval: "1s", timeout: "5s", retries: 120, start_period: "2s" } } : {}),
        },
      ]),
    ),
  };
}

/** The last lines of a service's logs. */
async function logTail(exec: Exec, base: string[], service: string, env: Record<string, string | undefined>, cwd: string): Promise<string> {
  const result = await exec([...base, "logs", "--no-color", "--no-log-prefix", "--tail", "20", service], { cwd, env });
  return (result.stdout || result.stderr).trimEnd();
}

/**
 * Starts the named services (catalog kinds, or requirement names of the project's description given in `services`)
 * in throwaway containers on random ports, in a compose project `qs-test-<random>`, and resolves their variables once
 * every health check passes. A kind whose `TEST_<KIND>_URL` is set uses that service instead of a container. The
 * containers stop with `stop()`, and at the latest when the process exits.
 */
export async function startServices(names: readonly string[], options: StartServicesOptions = {}): Promise<TestServices> {
  const key = [...names].sort().join(",");
  if (options.reuse) {
    const shared = reused.get(key);
    if (shared) {
      shared.users++;
      return shared.started;
    }
  }
  const env = options.env ?? process.env;
  const exec = options.exec ?? spawnExec;
  const timeout = options.timeout ?? "90s";
  const services = names.map((name) => serviceNamed(name, options.services ?? []));
  const external = services.filter((service) => env[testServiceVariable(service.kind)]);
  const containers = services.filter((service) => !external.includes(service));
  const endpoints: Record<string, InfraEndpoint> = Object.fromEntries(external.map((service) => [service.name, endpointOfUrl(env[testServiceVariable(service.kind)]!, service)]));
  const finish = (stop: () => Promise<void>, project?: string): TestServices => {
    const resolved = resolveInfraEnv(services, endpoints);
    // A service's own URL wins for its first variable, so `TEST_POSTGRES_URL` reaches the project as it is.
    for (const service of external) {
      const first = Object.keys(service.env)[0];
      if (first) resolved[first] = env[testServiceVariable(service.kind)]!;
    }
    const urls = Object.fromEntries(
      services.map((service) => {
        const first = Object.keys(service.env)[0];
        const url = external.includes(service) ? env[testServiceVariable(service.kind)]! : first ? resolveInfraTemplate(service.env[first]!, service, endpoints[service.name]!) : `${endpoints[service.name]!.host}:${endpoints[service.name]!.ports[service.ports[0]!]}`;
        return [service.name, url];
      }),
    );
    return { env: resolved, urls, ...(project ? { project } : {}), stop };
  };
  if (containers.length === 0) return finish(async () => {});
  installExitHandlers();
  const project = `qs-test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dir = mkdtempSync(join(tmpdir(), "qs-test-services-"));
  const file = join(dir, "compose.yml");
  writeFileSync(file, composeYaml(testDocument(project, containers) as never));
  const base = ["docker", "compose", "-f", file, "-p", project];
  const entry: RunningProject = { project, file, dir, users: 1, started: undefined as never };
  const stopProject = async () => {
    running.delete(project);
    writeState();
    if (reused.get(key) === entry) reused.delete(key);
    await exec([...base, "down", "--volumes", "--timeout", "1"], { cwd: dir, env });
    rmSync(dir, { recursive: true, force: true });
  };
  const stop = async () => {
    entry.users--;
    if (entry.users <= 0) await stopProject();
  };
  entry.started = (async () => {
    running.set(project, entry);
    startReaper();
    writeState();
    const seconds = Math.ceil((parseDuration(timeout) ?? 90_000) / 1000);
    const up = await exec([...base, "up", "-d", "--wait", "--wait-timeout", String(seconds)], { cwd: dir, env });
    if (up.code !== 0) {
      const states = await exec([...base, "ps", "--all", "--format", "json"], { cwd: dir, env });
      const unhealthy = parseStates(states.stdout).find((state) => state.health !== "healthy") ?? { service: containers[0]!.name };
      const logs = await logTail(exec, base, unhealthy.service, env, dir);
      await stopProject();
      throw new Error(`Service ${unhealthy.service} did not become healthy within ${timeout}\n${logs}`);
    }
    for (const service of containers) {
      const ports: Record<number, number> = {};
      for (const container of service.ports) {
        const mapped = await exec([...base, "port", service.name, String(container)], { cwd: dir, env });
        const port = Number(/:(\d+)\s*$/.exec(mapped.stdout.trim())?.[1]);
        if (!port) {
          await stopProject();
          throw new Error(`Service ${service.name} has no host port for ${container}: ${(mapped.stderr || mapped.stdout).trim()}`);
        }
        ports[container] = port;
      }
      endpoints[service.name] = { host: "127.0.0.1", ports };
    }
    return finish(stop, project);
  })();
  if (options.reuse) reused.set(key, entry);
  try {
    return await entry.started;
  } catch (error) {
    if (reused.get(key) === entry) reused.delete(key);
    throw error;
  }
}

/** The containers of a `docker compose ps --format json` output. */
function parseStates(output: string): { service: string; health: string }[] {
  const text = output.trim();
  if (text === "") return [];
  const entries: Record<string, unknown>[] = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  return entries.map((entry) => ({ service: String(entry.Service ?? ""), health: String(entry.Health ?? "") }));
}

/** Whether Docker with its compose plugin is usable from this process. */
export async function servicesAvailable(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return dockerAnswers(env);
}

/** Whether `docker compose version` succeeds, checked synchronously so test files can register skips. */
function dockerAnswers(env: Record<string, string | undefined>): boolean {
  const docker = Bun.which("docker", { PATH: env.PATH ?? "" });
  if (!docker) return false;
  try {
    return Bun.spawnSync([docker, "compose", "version"], { stdout: "ignore", stderr: "ignore", env: env as Record<string, string> }).exitCode === 0;
  } catch {
    return false;
  }
}

/** What `describeWithServices` accepts besides the names and the body. */
export interface DescribeWithServicesOptions extends Omit<StartServicesOptions, "reuse"> {}

/**
 * Starts the named services before the tests `fn` registers and stops them after, giving `fn` an object whose `env`
 * and `urls` are filled once the services are healthy. Where neither Docker nor every `TEST_<KIND>_URL` is available,
 * registers one skipped test naming the services and the variable to set instead.
 */
export function describeWithServices(names: readonly string[], fn: (services: Omit<TestServices, "stop">) => void, options: DescribeWithServicesOptions = {}): void {
  const env = options.env ?? process.env;
  const label = names.join(", ");
  const kinds = names.map((name) => serviceNamed(name, options.services ?? []).kind);
  const missing = [...new Set(kinds.filter((kind) => !env[testServiceVariable(kind)]))];
  if (missing.length > 0 && !dockerAnswers(env)) {
    const { test } = require("bun:test") as typeof import("bun:test");
    test.skip(`${label}: Docker is not available (set ${missing.map(testServiceVariable).join(" and ")} to use an existing service)`, () => {});
    return;
  }
  // Loaded here, so importing the testing helpers outside `bun test` works.
  const { afterAll, beforeAll, describe } = require("bun:test") as typeof import("bun:test");
  const holder: Omit<TestServices, "stop"> = { env: {}, urls: {} };
  let started: TestServices | undefined;
  describe(label, () => {
    beforeAll(async () => {
      started = await startServices(names, { ...options, reuse: true });
      Object.assign(holder.env, started.env);
      Object.assign(holder.urls, started.urls);
    }, (parseDuration(options.timeout ?? "90s") ?? 90_000) + 30_000);
    afterAll(async () => {
      await started?.stop();
    });
    fn(holder);
  });
}
