import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration, setUpDependents, runAfterHooks, runBeforeHooks, type FeatureHook, type ResolvedConfig } from "../public.ts";
import { COMPOSE_OVERRIDE_FILE, composeYaml, localServicesPlan, writeWhenChanged, type DevOptions, type LocalServicesPlan } from "./compose.ts";

/** What a container runner receives for one compose project: its files, its name and a signal that cancels the call. */
export interface ComposeCall {
  /** The compose files, the generated one first and the project's override after it. */
  files: string[];
  project: string;
  /** The project folder, where the command runs. */
  cwd: string;
  signal?: AbortSignal;
}

/** One container of a compose project, as `status` reports it. */
export interface ContainerStatus {
  /** The compose service name. */
  service: string;
  /** `running`, `exited`, `created`… */
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or empty without a health check. */
  health: string;
}

/** Starts, stops and inspects compose projects; the default one runs `docker compose`. */
export interface ContainerRunner {
  /** Starts the services and waits for their health checks, within `waitSeconds`. */
  up(call: ComposeCall & { waitSeconds: number }): Promise<void>;
  /** Stops and removes the containers, and the volumes with `volumes`. */
  down(call: ComposeCall & { volumes?: boolean }): Promise<void>;
  status(call: ComposeCall): Promise<ContainerStatus[]>;
  /** The logs of every service, or of one, as text. */
  logs(call: ComposeCall & { service?: string; tail?: number }): Promise<string>;
}

/** The result of running a command. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and resolves its exit code and output; tests give a fake one. */
export type Exec = (command: readonly string[], options: { cwd: string; env: Record<string, string | undefined>; signal?: AbortSignal }) => Promise<ExecResult>;

/** Runs a command with `Bun.spawn`, resolving exit code 127 when the program cannot be found. */
export const spawnExec: Exec = async (command, { cwd, env, signal }) => {
  const program = Bun.which(command[0]!, { PATH: env.PATH ?? "" });
  if (!program) return { code: 127, stdout: "", stderr: `${command[0]}: command not found` };
  const child = Bun.spawn([program, ...command.slice(1)], { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe", ...(signal ? { signal } : {}) });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

/** The message when Docker or its compose plugin is missing. */
export const DOCKER_MISSING = "quickservicets dev --services needs Docker with the compose plugin; install it or start the services yourself";

/** The message when local services are asked for in production. */
export const DEVELOPMENT_ONLY = "Local services are for development only";

/** The message of a host port another process holds. */
export const portInUse = (port: number, name: string) => `Port ${port} for ${name} is in use; set dev.services.${name}.port`;

/** A failure of the local services commands, printed and exiting with 1. */
export class LocalServicesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalServicesError";
  }
}

/** The arguments every compose call starts with. */
const composeArgs = (call: ComposeCall) => ["docker", "compose", ...call.files.flatMap((file) => ["-f", file]), "-p", call.project];

/** The containers of a `docker compose ps --format json` output, one JSON object per line or one array. */
export function parseComposeStatus(output: string): ContainerStatus[] {
  const text = output.trim();
  if (text === "") return [];
  const entries: Record<string, unknown>[] = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  return entries.map((entry) => ({ service: String(entry.Service ?? entry.Name ?? ""), state: String(entry.State ?? ""), health: String(entry.Health ?? "") }));
}

/** The runner that calls `docker compose` through `exec`. */
export function dockerComposeRunner(exec: Exec = spawnExec, env: Record<string, string | undefined> = process.env, command: readonly string[] = ["docker", "compose"]): ContainerRunner {
  const run = async (call: ComposeCall, args: string[]) => {
    const result = await exec([...command, ...composeArgs(call).slice(2), ...args], { cwd: call.cwd, env, ...(call.signal ? { signal: call.signal } : {}) });
    if (result.code !== 0) throw new LocalServicesError(`docker compose ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  return {
    async up(call) {
      await run(call, ["up", "-d", "--wait", "--wait-timeout", String(call.waitSeconds)]);
    },
    async down(call) {
      await run(call, ["down", ...(call.volumes ? ["--volumes"] : [])]);
    },
    async status(call) {
      return parseComposeStatus(await run(call, ["ps", "--all", "--format", "json"]));
    },
    async logs(call) {
      return run(call, ["logs", "--no-color", ...(call.tail !== undefined ? ["--tail", String(call.tail)] : []), ...(call.service ? [call.service] : [])]);
    },
  };
}

/** Whether Docker with its compose plugin answers. */
export async function dockerAvailable(exec: Exec = spawnExec, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<boolean> {
  try {
    return (await exec(["docker", "compose", "version"], { cwd, env })).code === 0;
  } catch {
    return false;
  }
}

/** Whether a host port can be bound, on every address and on loopback. */
export function portFree(port: number): boolean {
  for (const hostname of ["0.0.0.0", "127.0.0.1"]) {
    try {
      const listener = Bun.listen({ hostname, port, socket: { data() {} } });
      listener.stop(true);
    } catch {
      return false;
    }
  }
  return true;
}

/** The variables set in the project's `.env` files, by name. */
export function envFileValues(root: string, mode = "development"): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of [".env", `.env.${mode}`, ".env.local"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]!] = match[2]!.replace(/^(["'`])(.*)\1$/, "$2");
    }
  }
  return values;
}

/** What the local services commands need. */
export interface LocalServicesContext {
  /** The project folder. */
  root: string;
  /** The project's resolved configuration. */
  config: Record<string, unknown> & { production?: boolean };
  /** The `dev` native's resolved options. */
  options: DevOptions;
  /** The environment (default: the process's). */
  env?: Record<string, string | undefined>;
  /** Replaces `docker compose` (default: the Docker runner through `exec`). */
  runner?: ContainerRunner;
  /** Runs Docker for the default runner and its detection. */
  exec?: Exec;
  log(line: string): void;
}

/** The plan of the local services, refusing production. */
export function planLocalServices(ctx: Pick<LocalServicesContext, "root" | "config" | "options" | "env">): LocalServicesPlan {
  const env = ctx.env ?? process.env;
  if (ctx.config.production === true || env.NODE_ENV === "production") throw new LocalServicesError(DEVELOPMENT_ONLY);
  return localServicesPlan(ctx.config, ctx.options, ctx.root);
}

/** The runner of a context, checking that Docker answers when it is the default one. */
async function runnerOf(ctx: LocalServicesContext): Promise<ContainerRunner> {
  if (ctx.runner) return ctx.runner;
  if (ctx.options.runner) return ctx.options.runner;
  const env = ctx.env ?? process.env;
  if (!(await dockerAvailable(ctx.exec, env, ctx.root))) throw new LocalServicesError(DOCKER_MISSING);
  return dockerComposeRunner(ctx.exec, env);
}

/** The compose call of a plan: the generated file, then the project's override file when it exists. */
export function composeCall(root: string, plan: Pick<LocalServicesPlan, "file" | "project">): ComposeCall {
  const override = join(root, COMPOSE_OVERRIDE_FILE);
  return { files: [join(root, plan.file), ...(existsSync(override) ? [override] : [])], project: plan.project, cwd: root };
}

/**
 * Runs the setups of the features that list `dev` in `requires` or `after`, so the hooks they add through
 * `ctx.feature("dev").addHook` apply to these commands; resolves a function that stops them.
 */
export async function setUpDevDependents(config: Record<string, unknown>): Promise<() => Promise<void>> {
  return setUpDependents(config as unknown as ResolvedConfig, "dev");
}

/** What `startLocalServices` resolves: the plan and the variables the development server receives. */
export interface StartedServices {
  plan: LocalServicesPlan;
  /** The variables of the services not already set in the environment or the `.env` files. */
  env: Record<string, string>;
}

/** The connection variables of databases, which `dev --services` also writes to `.env`. */
const DATABASE_VARIABLE = /^(DATABASE_URL|QS_DATABASES_[A-Z0-9_]+_URL)$/;

/**
 * Writes the compose file and starts the services, waiting for their health checks within `dev.wait`; prints one line
 * per service and resolves the variables the development server receives (those the environment and the `.env` files
 * do not set). Database connections missing from `.env` are appended to it.
 */
export async function startLocalServices(ctx: LocalServicesContext): Promise<StartedServices> {
  const env = ctx.env ?? process.env;
  const plan = planLocalServices(ctx);
  if (plan.services.length === 0) {
    ctx.log("No local services: the project needs none");
    return { plan, env: {} };
  }
  const runner = await runnerOf(ctx);
  const call = composeCall(ctx.root, plan);
  const file = join(ctx.root, plan.file);
  // Services of this project already running hold their own ports.
  const running = existsSync(file) ? new Set((await runner.status(call).catch(() => [])).filter((entry) => entry.state === "running").map((entry) => entry.service)) : new Set<string>();
  for (const service of plan.services) {
    if (running.has(service.name)) continue;
    for (const port of Object.values(service.ports)) if (!portFree(port)) throw new LocalServicesError(portInUse(port, service.name));
  }
  const stopDependents = await setUpDevDependents(ctx.config);
  try {
    const document = await runBeforeHooks((ctx.options.beforeCompose ?? []) as FeatureHook<typeof plan.document, { project: string }>[], plan.document, { project: plan.project });
    writeWhenChanged(file, composeYaml(document));
    await runner.up({ ...call, waitSeconds: Math.ceil((parseDuration(ctx.options.wait) ?? 60_000) / 1000) });
    for (const service of plan.services) ctx.log(`Service ${service.name} (${service.image}) on localhost:${service.port}`);
    await runAfterHooks((ctx.options.afterUp ?? []) as FeatureHook<{ services: { name: string; image: string; port: number }[]; env: Record<string, string> }, undefined>[], { services: plan.services.map((service) => ({ name: service.name, image: service.image, port: service.port })), env: { ...plan.env } }, undefined);
  } finally {
    await stopDependents();
  }
  const fromFiles = envFileValues(ctx.root, env.NODE_ENV || "development");
  const injected = Object.fromEntries(Object.entries(plan.env).filter(([name]) => env[name] === undefined && fromFiles[name] === undefined));
  const missing = Object.entries(injected).filter(([name]) => DATABASE_VARIABLE.test(name));
  if (missing.length > 0) {
    const dotenv = join(ctx.root, ".env");
    const current = existsSync(dotenv) ? readFileSync(dotenv, "utf8") : "";
    appendFileSync(dotenv, `${current === "" || current.endsWith("\n") ? "" : "\n"}${missing.map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
  }
  return { plan, env: injected };
}

/** Stops the services, removing their volumes with `volumes`. */
export async function stopLocalServices(ctx: LocalServicesContext, volumes = false): Promise<void> {
  const plan = planLocalServices(ctx);
  await (await runnerOf(ctx)).down({ ...composeCall(ctx.root, plan), volumes });
}

/** One line per service of the plan with its container's state. */
export async function localServicesStatus(ctx: LocalServicesContext): Promise<string[]> {
  const plan = planLocalServices(ctx);
  const states = existsSync(join(ctx.root, plan.file)) ? await (await runnerOf(ctx)).status(composeCall(ctx.root, plan)) : [];
  return plan.services.map((service) => {
    const state = states.find((entry) => entry.service === service.name);
    return `${service.name}  ${state ? `${state.state}${state.health ? ` (${state.health})` : ""}` : "not started"}  localhost:${service.port}`;
  });
}

/** The logs of the services, or of one. */
export async function localServicesLogs(ctx: LocalServicesContext, service?: string): Promise<string> {
  const plan = planLocalServices(ctx);
  if (service !== undefined && !plan.services.some((entry) => entry.name === service)) throw new LocalServicesError(`Unknown service ${service}; the services are ${plan.services.map((entry) => entry.name).join(", ") || "none"}`);
  return (await runnerOf(ctx)).logs({ ...composeCall(ctx.root, plan), ...(service ? { service } : {}) });
}

/** The resolved variables as `NAME=value` lines, with passwords replaced by `[secret]` unless `show`. */
export function localServicesEnv(ctx: Pick<LocalServicesContext, "root" | "config" | "options" | "env">, show = false): string[] {
  const plan = planLocalServices(ctx);
  return Object.entries(show ? plan.env : plan.maskedEnv).map(([name, value]) => `${name}=${value}`);
}
