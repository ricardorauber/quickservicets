/**
 * The cold-start scenario: builds a small SQLite service for the `server`, `binary` and `lambda` targets and starts
 * each one many times, measuring the milliseconds from spawn to its first answer.
 *
 *   bun benchmarks/run.ts cold-start [--runs 20] [--out benchmarks/results/cold-start.json]
 */
import { cpus } from "node:os";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/**
 * Where the project is built and each target starts: inside the repository, because a working folder in the system's
 * temporary folder makes every process start slower on some machines (macOS checks files there).
 */
const WORK = join(import.meta.dir, ".cache/cold-start");
export const COLD_START_TARGETS = ["server", "binary", "lambda"] as const;
export type ColdStartTarget = (typeof COLD_START_TARGETS)[number];

/** The phases of the `service.started` log entry, in milliseconds. */
export type StartupPhases = { config: number; setup: number; connect: number; start: number };

/** The numbers of one target. */
export interface TargetResult {
  p50: number;
  p90: number;
  /** Every measured start, in milliseconds. */
  runs: number[];
  /** The artifact's size in bytes. */
  bytes: number;
  /** The median phase timings of the `service.started` entry (server target). */
  phases?: StartupPhases;
}

/** A result file of the scenario. */
export interface ColdStartResult {
  scenario: "cold-start";
  date: string;
  bun: string;
  machine: { platform: string; arch: string; cpu: string; cpus: number; load?: number[] };
  targets: Partial<Record<ColdStartTarget, TargetResult>>;
}

/** The value at a percentile of measured values (nearest rank). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** One start of a process: resolves when its first answer arrived, with the lines it printed until then. */
export type Launch = () => Promise<{ ms: number; output: string }>;

/** Runs `launch` `runs` times, one after the other, and summarizes the times. */
export async function measureColdStart(launch: Launch, runs: number, bytes: number): Promise<TargetResult & { outputs: string[] }> {
  const times: number[] = [];
  const outputs: string[] = [];
  for (let run = 0; run < runs; run++) {
    const { ms, output } = await launch();
    times.push(Math.round(ms * 10) / 10);
    outputs.push(output);
  }
  return { p50: percentile(times, 50), p90: percentile(times, 90), runs: times, bytes, outputs };
}

/** The median of each phase of the `service.started` entries in the outputs of the runs. */
export function medianPhases(outputs: readonly string[]): StartupPhases | undefined {
  const phases = outputs.flatMap((output) =>
    output.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { message?: string; phases?: StartupPhases };
        return entry.message === "service.started" && entry.phases ? [entry.phases] : [];
      } catch {
        return [];
      }
    }),
  );
  if (phases.length === 0) return undefined;
  const median = (key: keyof StartupPhases) => percentile(phases.map((entry) => entry[key]), 50);
  return { config: median("config"), setup: median("setup"), connect: median("connect"), start: median("start") };
}

/** A free port on loopback. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** Starts a server process and resolves when `GET /posts?limit=1` first answers 200. */
function launchServer(command: string[], cwd: string): Launch {
  return async () => {
    const port = freePort();
    const started = performance.now();
    const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH ?? "", PORT: String(port), HOME: process.env.HOME ?? "" }, stdout: "pipe", stderr: "ignore" });
    try {
      for (;;) {
        const answer = await fetch(`http://127.0.0.1:${port}/posts?limit=1`).catch(() => undefined);
        if (answer?.status === 200) {
          const ms = performance.now() - started;
          child.kill();
          await child.exited;
          return { ms, output: await new Response(child.stdout).text() };
        }
        if (child.exitCode !== null) throw new Error(`${command.join(" ")} exited with ${child.exitCode} before answering`);
        await Bun.sleep(1);
      }
    } finally {
      child.kill();
    }
  };
}

/** Starts the Lambda bootstrap against a local Runtime API and resolves when the result of a 2.0 event is posted. */
function launchLambda(bootstrap: string, cwd: string): Launch {
  return async () => {
    let answered: (() => void) | undefined;
    const done = new Promise<void>((resolve) => (answered = resolve));
    let served = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/invocation/next")) {
          if (served) return new Promise<Response>(() => {});
          served = true;
          return Response.json(
            { version: "2.0", rawPath: "/posts", rawQueryString: "limit=1", headers: { host: "bench.lambda-url.local" }, requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } },
            { headers: { "lambda-runtime-aws-request-id": "bench", "lambda-runtime-deadline-ms": String(Date.now() + 30_000) } },
          );
        }
        await request.arrayBuffer();
        if (path.endsWith("/response")) answered?.();
        return new Response(null, { status: 202 });
      },
    });
    const started = performance.now();
    const child = Bun.spawn([bootstrap], { cwd, env: { PATH: process.env.PATH ?? "", AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "ignore" });
    try {
      await done;
      const ms = performance.now() - started;
      child.kill();
      await child.exited;
      return { ms, output: await new Response(child.stdout).text() };
    } finally {
      child.kill();
      server.stop(true);
    }
  };
}

/** The size of a file or of every file in a folder. */
function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0);
}

/** The platform of this machine, as a deploy platform. */
const machinePlatform = () => `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** Writes the benchmark project, a `Post` entity on SQLite, migrates it and builds the three targets for this machine. */
export async function buildColdStartProject(): Promise<{ root: string; data: string }> {
  mkdirSync(WORK, { recursive: true });
  const root = mkdtempSync(join(WORK, "project-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "cold-start", private: true, type: "module" }),
    "quickservicets.config.ts": `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }), deploy: { platform: "${machinePlatform()}" } });\n`,
    "entities/Post.ts": "export type Post = {\n  /** @minLength 1 */\n  title: string;\n  body?: string;\n};\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(join(ROOT, "packages/core"), join(root, "node_modules/@quickservicets/core"), "dir");
  symlinkSync(join(ROOT, "packages/cli"), join(root, "node_modules/@quickservicets/cli"), "dir");
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(ROOT, "packages/cli/src/index.ts"), ...args], { cwd: root, env: { ...process.env, DATABASE_PATH: join(root, "data.db") }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`quickservicets ${args.join(" ")} failed:\n${result.stderr.toString()}${result.stdout.toString()}`);
  };
  cli("migration", "add", "CreatePosts");
  cli("migrate");
  for (const target of COLD_START_TARGETS) cli("build", "--target", target);
  return { root, data: join(root, "data.db") };
}

/** Builds the targets, starts each one `runs` times and returns the result. */
export async function runColdStart(runs: number): Promise<ColdStartResult> {
  const { root, data } = await buildColdStartProject();
  try {
    const targets: ColdStartResult["targets"] = {};
    for (const target of COLD_START_TARGETS) {
      // Each target starts in a folder holding only its artifact and the migrated database.
      const folder = mkdtempSync(join(WORK, `${target}-`));
      try {
        cpSync(join(root, "dist", target), join(folder, target), { recursive: true });
        cpSync(data, join(folder, "data.db"));
        const artifact = target === "server" ? join(folder, "server") : target === "binary" ? join(folder, "binary/cold-start") : join(folder, "lambda/bootstrap");
        const launch = target === "server" ? launchServer([process.execPath, "server/server.js"], folder) : target === "binary" ? launchServer([artifact], folder) : launchLambda(artifact, folder);
        const measured = await measureColdStart(launch, runs, target === "lambda" ? sizeOf(join(folder, "lambda/function.zip")) : sizeOf(artifact));
        const { outputs, ...result } = measured;
        const phases = target === "server" ? medianPhases(outputs) : undefined;
        targets[target] = { ...result, ...(phases ? { phases } : {}) };
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
    return {
      scenario: "cold-start",
      date: new Date().toISOString(),
      bun: Bun.version,
      machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? "unknown", cpus: cpus().length, load: (await import("node:os")).loadavg().map((value) => Math.round(value * 10) / 10) },
      targets,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `bun benchmarks/run.ts cold-start [--runs n] [--out file]`. */
export async function main(args: readonly string[]): Promise<number> {
  const value = (name: string, fallback: string) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
  };
  const runs = Number(value("--runs", "20"));
  const out = resolve(value("--out", join(ROOT, "benchmarks/results/cold-start.json")));
  const result = await runColdStart(runs);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const [target, numbers] of Object.entries(result.targets)) console.log(`${target}: p50 ${numbers.p50} ms, p90 ${numbers.p90} ms, ${(numbers.bytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`Wrote ${out}`);
  return 0;
}
