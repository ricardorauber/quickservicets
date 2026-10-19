#!/usr/bin/env bun
/**
 * Benchmark runner. For each stack: build its image, start it next to PostgreSQL, measure startup, check
 * conformance, run every k6 scenario, sample memory and CPU, and write benchmarks/results/<stack>.json.
 *
 *   bun benchmarks/run.ts quickservice
 *   bun benchmarks/run.ts quickservice express --scenarios crud,query
 *   bun benchmarks/run.ts all
 *
 * Options:
 *   --scenarios a,b     scenarios to run (default: all, see SCENARIOS)
 *   --duration 30s      measured duration per scenario
 *   --warmup 10s        warmup duration per scenario (its results are discarded)
 *   --vus 64            concurrent virtual users
 *   --startup-runs 3    cold starts used for the startup measurement
 *   --skip-build        reuse the existing qsbench-<stack> image
 *   --keep-going        run the load scenarios even when conformance fails (the default stops the stack)
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtures, seedSql } from "./seed/seed.ts";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = import.meta.dir;
const CACHE = join(BENCH, ".cache");
const RESULTS = join(BENCH, "results");
const COMPOSE = join(BENCH, "docker-compose.yml");

const K6_IMAGE = "grafana/k6:2.3.0";
const JANITOR_IMAGE = "busybox:1.37.0";
const NETWORK = "qsbench";
const POSTGRES = "qsbench-postgres";
const APP = "qsbench-app";
const JANITOR = "qsbench-janitor";
const APP_HOST_PORT = 18080;
const APP_CPUS = "2";
const APP_MEMORY = "1g";
const K6_CPUS = "4";
const DB_POOL_SIZE = 10;
const DATABASE_URL = `postgres://bench:bench@${POSTGRES}:5432/bench`;

type Scenario = { script: string; env?: Record<string, string>; description: string };

/** The four study scenarios first, then single-endpoint variants for profiling. */
const SCENARIOS: Record<string, Scenario> = {
  crud: { script: "crud.js", description: "GET /users/{id}, GET /users?limit=20&offset=n, POST, PATCH and DELETE /users" },
  query: { script: "query.js", description: "filtered/sorted/projected user list + organizations with populated members" },
  custom: { script: "custom.js", description: "GET /organizations/{id}/stats" },
  upload: { script: "upload.js", description: "POST /media with a 50 KB PNG" },
  health: { script: "single.js", env: { ENDPOINT: "health" }, description: "GET /health only (framework floor)" },
  get_user: { script: "single.js", env: { ENDPOINT: "get_user" }, description: "GET /users/{id} only" },
  list_users: { script: "single.js", env: { ENDPOINT: "list_users" }, description: "GET /users?limit=20&offset=n only" },
  create_user: { script: "single.js", env: { ENDPOINT: "create_user" }, description: "POST /users only" },
  filter_users: { script: "single.js", env: { ENDPOINT: "filter_users" }, description: "the filtered user list only" },
  populate_orgs: { script: "single.js", env: { ENDPOINT: "populate_orgs" }, description: "GET /organizations?populate=members&limit=10 only" },
};

// ----------------------------------------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith("--")) positional.push(arg);
  else if (["--skip-build", "--keep-going"].includes(arg)) flags.set(arg, true);
  else flags.set(arg, argv[++i] ?? "");
}
const flag = (name: string, fallback: string) => (typeof flags.get(name) === "string" ? (flags.get(name) as string) : fallback);

const DURATION = flag("--duration", "30s");
const WARMUP = flag("--warmup", "10s");
const VUS = flag("--vus", "64");
const STARTUP_RUNS = Number(flag("--startup-runs", "3"));
const scenarioNames = flag("--scenarios", Object.keys(SCENARIOS).join(",")).split(",").filter(Boolean);
for (const name of scenarioNames) if (!SCENARIOS[name]) fail(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}`);

function availableStacks(): string[] {
  const dir = join(BENCH, "stacks");
  const others = existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "Dockerfile"))).sort() : [];
  return ["quickservice", "quickservice-2proc", ...others];
}
const known = availableStacks();
const stacks = positional.length === 0 || positional.includes("all") ? known : positional;
for (const stack of stacks) if (!known.includes(stack)) fail(`Unknown stack "${stack}". Known: ${known.join(", ")}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ----------------------------------------------------------------------------------------------- docker helpers

async function sh(command: string[], options: { stdin?: string; quiet?: boolean; allowFailure?: boolean } = {}) {
  const proc = Bun.spawn(command, { stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !options.allowFailure) throw new Error(`${command.join(" ")} exited with ${code}\n${stderr || stdout}`);
  return { stdout, stderr, code };
}

async function psql(sql: string) {
  await sh(["docker", "exec", "-i", POSTGRES, "psql", "-q", "-U", "bench", "-d", "bench", "-v", "ON_ERROR_STOP=1"], { stdin: sql });
}

async function startPostgres() {
  log("Starting PostgreSQL (docker compose)");
  await sh(["docker", "compose", "-f", COMPOSE, "up", "-d", "--wait"]);
}

async function resetSchema() {
  const schema = await Bun.file(join(BENCH, "schema", "schema.sql")).text();
  await psql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n${schema}`);
}

const SEED_SQL = seedSql();
async function seed() {
  await psql(SEED_SQL);
}

async function buildImage(stack: string): Promise<{ image: string; buildSeconds: number | null }> {
  const image = `qsbench-${stack}`;
  if (flags.get("--skip-build")) return { image, buildSeconds: null };
  // QuickService variants build from the repository root; "quickservice-2proc" is an experiment (see quickservice/Dockerfile.2proc).
  const isQuickService = stack.startsWith("quickservice");
  const dockerfile = isQuickService
    ? join(BENCH, "quickservice", stack === "quickservice" ? "Dockerfile" : `Dockerfile.${stack.slice("quickservice-".length)}`)
    : join(BENCH, "stacks", stack, "Dockerfile");
  const context = isQuickService ? ROOT : join(BENCH, "stacks", stack);
  log(`Building ${image}`);
  const started = performance.now();
  const proc = Bun.spawn(["docker", "build", "-f", dockerfile, "-t", image, context], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`docker build failed for ${stack}`);
  return { image, buildSeconds: (performance.now() - started) / 1000 };
}

async function imageSize(image: string): Promise<number> {
  return Number((await sh(["docker", "image", "inspect", "-f", "{{.Size}}", image])).stdout.trim());
}

async function removeApp() {
  await sh(["docker", "rm", "-f", "-v", APP], { allowFailure: true });
}

async function waitForHealth(timeoutMs: number): Promise<number | null> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${APP_HOST_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      await res.arrayBuffer();
      if (res.status === 200) return performance.now();
    } catch {
      // not listening yet
    }
    await Bun.sleep(5);
  }
  return null;
}

/** Process start to first 200 on /health: `docker start` is issued, then /health is polled every 5 ms. */
async function measureStartup(runs: number): Promise<number[]> {
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    if (run > 0) await sh(["docker", "stop", "-t", "10", APP]);
    const started = performance.now();
    await sh(["docker", "start", APP]);
    const ready = await waitForHealth(60_000);
    if (ready === null) {
      const logs = await sh(["docker", "logs", "--tail", "50", APP], { allowFailure: true });
      throw new Error(`The service did not answer 200 on /health within 60 s\n${logs.stdout}${logs.stderr}`);
    }
    samples.push(ready - started);
  }
  return samples;
}

/**
 * Keeps the upload volume small during the load: every 2 seconds, deletes the stored files (and emptied record
 * folders) that are older than the previous pass. A 30-second upload run would otherwise write gigabytes. It runs
 * in its own container, so its CPU is not charged to the service.
 */
async function startJanitor(volume: string) {
  await stopJanitor();
  const loop =
    "touch /tmp/old; while true; do sleep 2; touch /tmp/new; " +
    "find /data -mindepth 2 ! -newer /tmp/old \\( -type f -o -type d -empty \\) -delete 2>/dev/null; mv /tmp/new /tmp/old; done";
  await sh(["docker", "run", "-d", "--name", JANITOR, "--cpus=0.25", "-v", `${volume}:/data`, JANITOR_IMAGE, "sh", "-c", loop]);
}

async function stopJanitor() {
  await sh(["docker", "rm", "-f", JANITOR], { allowFailure: true });
}

// ----------------------------------------------------------------------------------------------- resource sampling

type Sample = { t: number; phase: string; memMiB: number; cpuPercent: number };

function parseMiB(text: string): number {
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(text);
  if (!match) return NaN;
  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const factor: Record<string, number> = { B: 1 / 1048576, KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024, TB: 1048576, TIB: 1048576 };
  return value * (factor[unit] ?? NaN);
}

/** Streams `docker stats` for one container; each line is tagged with the current phase. */
function startSampler(container: string) {
  const samples: Sample[] = [];
  let phase = "idle";
  const proc = Bun.spawn(["docker", "stats", "--format", "{{json .}}", container], { stdout: "pipe", stderr: "ignore" });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        // docker stats clears the screen between refreshes; strip the escape sequences.
        const line = buffer.slice(0, newline).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          const row = JSON.parse(line);
          const memMiB = parseMiB(String(row.MemUsage).split("/")[0]!);
          const cpuPercent = Number(String(row.CPUPerc).replace("%", ""));
          if (Number.isFinite(memMiB) && memMiB > 0) samples.push({ t: Date.now(), phase, memMiB, cpuPercent });
        } catch {
          // partial line
        }
      }
    }
  })();
  return {
    samples,
    setPhase(next: string) {
      phase = next;
    },
    stop() {
      proc.kill();
    },
  };
}

function summarize(samples: Sample[]) {
  if (samples.length === 0) return { samples: 0, peakMemMiB: null, avgMemMiB: null, avgCpuPercent: null, peakCpuPercent: null };
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    samples: samples.length,
    peakMemMiB: round(Math.max(...samples.map((s) => s.memMiB))),
    avgMemMiB: round(samples.reduce((a, s) => a + s.memMiB, 0) / samples.length),
    avgCpuPercent: round(samples.reduce((a, s) => a + s.cpuPercent, 0) / samples.length),
    peakCpuPercent: round(Math.max(...samples.map((s) => s.cpuPercent))),
  };
}

// ----------------------------------------------------------------------------------------------- conformance and k6

async function runConformance() {
  const proc = Bun.spawn(["bun", "test", "./benchmarks/conformance/conformance.ts"], {
    cwd: ROOT,
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${APP_HOST_PORT}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const output = stdout + stderr;
  const count = (label: string) => Number(new RegExp(`(\\d+) ${label}`).exec(output)?.[1] ?? 0);
  const failures = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!);
  return { passed: code === 0, pass: count("pass"), fail: count("fail"), failures, output };
}

async function runK6(stack: string, name: string, duration: string, label: string) {
  const scenario = SCENARIOS[name]!;
  const outDir = join(CACHE, "out", stack);
  mkdirSync(outDir, { recursive: true });
  const file = `${name}.${label}.json`;
  rmSync(join(outDir, file), { force: true });
  const env = { BASE_URL: `http://${APP}:8080`, VUS, DURATION: duration, RUN_ID: `${stack}-${name}-${label}-${Date.now()}`, SUMMARY_OUT: `/out/${file}`, ...scenario.env };
  const command = [
    "docker", "run", "--rm", "--name", "qsbench-k6", "--network", NETWORK, `--cpus=${K6_CPUS}`,
    "-v", `${join(BENCH, "load")}:/load:ro`, "-v", `${CACHE}:/fixtures:ro`, "-v", `${outDir}:/out`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    K6_IMAGE, "run", "--quiet", "--no-usage-report", `/load/${scenario.script}`,
  ];
  const result = await sh(command, { allowFailure: true });
  if (!existsSync(join(outDir, file))) throw new Error(`k6 wrote no summary for ${name} (${label})\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(await Bun.file(join(outDir, file)).text());
}

async function containerState() {
  const { stdout } = await sh(["docker", "inspect", "-f", "{{json .State}}", APP], { allowFailure: true });
  try {
    const state = JSON.parse(stdout);
    return { running: state.Running as boolean, oomKilled: state.OOMKilled as boolean, exitCode: state.ExitCode as number };
  } catch {
    return { running: false, oomKilled: false, exitCode: -1 };
  }
}

// ----------------------------------------------------------------------------------------------- one stack

async function environment() {
  const info = await sh(["docker", "info", "--format", "{{json .}}"], { allowFailure: true });
  let docker: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(info.stdout);
    docker = { serverVersion: parsed.ServerVersion, operatingSystem: parsed.OperatingSystem, cpus: parsed.NCPU, memoryBytes: parsed.MemTotal, architecture: parsed.Architecture };
  } catch {
    // docker info unavailable
  }
  const commit = (await sh(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], { allowFailure: true })).stdout.trim();
  return { host: `${process.platform}/${process.arch}`, docker, gitCommit: commit || null, bun: Bun.version };
}

async function runStack(stack: string) {
  log(`=== ${stack} ===`);
  const { image, buildSeconds } = await buildImage(stack);
  const sizeBytes = await imageSize(image);

  log("Resetting the schema and seeding");
  await resetSchema();
  await seed();

  const volume = `qsbench-uploads-${stack}`;
  await removeApp();
  await sh(["docker", "volume", "rm", "-f", volume], { allowFailure: true });
  await sh(["docker", "volume", "create", volume]);
  await sh([
    "docker", "create", "--name", APP, "--network", NETWORK, `--cpus=${APP_CPUS}`, `--memory=${APP_MEMORY}`, `--memory-swap=${APP_MEMORY}`,
    "-p", `127.0.0.1:${APP_HOST_PORT}:8080`, "-v", `${volume}:/data/uploads`, "--log-opt", "max-size=20m", "--log-opt", "max-file=2",
    "-e", "PORT=8080", "-e", `DATABASE_URL=${DATABASE_URL}`, "-e", `DB_HOST=${POSTGRES}`, "-e", "DB_PORT=5432", "-e", "DB_USER=bench",
    "-e", "DB_PASSWORD=bench", "-e", "DB_NAME=bench", "-e", `DB_POOL_SIZE=${DB_POOL_SIZE}`, "-e", "UPLOAD_DIR=/data/uploads",
    image,
  ]);

  const result: Record<string, any> = {
    stack,
    startedAt: new Date().toISOString(),
    settings: { vus: Number(VUS), duration: DURATION, warmup: WARMUP, appCpus: Number(APP_CPUS), appMemory: APP_MEMORY, k6Cpus: Number(K6_CPUS), dbPoolSize: DB_POOL_SIZE, k6Image: K6_IMAGE },
    environment: await environment(),
    image: { name: image, sizeBytes, sizeMB: Math.round((sizeBytes / 1e6) * 10) / 10, buildSeconds: buildSeconds === null ? null : Math.round(buildSeconds * 10) / 10 },
  };

  let sampler: ReturnType<typeof startSampler> | undefined;
  let dbSampler: ReturnType<typeof startSampler> | undefined;
  const setPhase = (phase: string) => {
    sampler?.setPhase(phase);
    dbSampler?.setPhase(phase);
  };
  try {
    log(`Measuring startup (${STARTUP_RUNS} cold starts)`);
    const startups = await measureStartup(STARTUP_RUNS);
    const sorted = [...startups].sort((a, b) => a - b);
    result.startup = { medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]!), minMs: Math.round(sorted[0]!), samplesMs: startups.map(Math.round) };

    sampler = startSampler(APP);
    dbSampler = startSampler(POSTGRES);
    await Bun.sleep(5000);
    result.memory = { idle: summarize(sampler.samples.filter((s) => s.phase === "idle")) };

    log("Running conformance");
    setPhase("conformance");
    const conformance = await runConformance();
    result.conformance = { passed: conformance.passed, pass: conformance.pass, fail: conformance.fail, failures: conformance.failures };
    log(`Conformance: ${conformance.pass} pass, ${conformance.fail} fail`);
    if (!conformance.passed) {
      await Bun.write(join(RESULTS, `${stack}.conformance.txt`), conformance.output);
      if (!flags.get("--keep-going")) throw new Error(`Conformance failed for ${stack}; see benchmarks/results/${stack}.conformance.txt (or pass --keep-going)`);
    }

    await startJanitor(volume);
    result.scenarios = {};
    for (const name of scenarioNames) {
      await seed();
      log(`Scenario ${name}: warmup ${WARMUP}`);
      setPhase(`warmup:${name}`);
      await runK6(stack, name, WARMUP, "warmup");
      log(`Scenario ${name}: measuring ${DURATION}`);
      setPhase(`measure:${name}`);
      const summary = await runK6(stack, name, DURATION, "measure");
      setPhase("between");
      const state = await containerState();
      result.scenarios[name] = {
        description: SCENARIOS[name]!.description,
        ...summary,
        resources: summarize(sampler.samples.filter((s) => s.phase === `measure:${name}`)),
        postgres: summarize(dbSampler!.samples.filter((s) => s.phase === `measure:${name}`)),
        container: state,
      };
      log(`  ${Math.round(summary.reqPerSec)} req/s, p50 ${summary.latencyMs.p50.toFixed(2)} ms, p99 ${summary.latencyMs.p99.toFixed(2)} ms, errors ${(summary.errorRate * 100).toFixed(2)}%`);
      if (!state.running) throw new Error(`The service stopped during ${name} (oomKilled: ${state.oomKilled}, exit ${state.exitCode})`);
    }
    result.memory.peakMiB = Math.max(...sampler.samples.map((s) => s.memMiB));
    result.memory.peakMiB = Math.round(result.memory.peakMiB * 10) / 10;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${result.error}`);
  } finally {
    sampler?.stop();
    dbSampler?.stop();
    await stopJanitor();
    result.finishedAt = new Date().toISOString();
    await removeApp();
    await sh(["docker", "volume", "rm", "-f", volume], { allowFailure: true });
  }

  mkdirSync(RESULTS, { recursive: true });
  await Bun.write(join(RESULTS, `${stack}.json`), JSON.stringify(result, null, 2) + "\n");
  log(`Wrote benchmarks/results/${stack}.json`);
  return result;
}

// ----------------------------------------------------------------------------------------------- main

mkdirSync(CACHE, { recursive: true });
await Bun.write(join(CACHE, "fixtures.json"), JSON.stringify(fixtures()));
await startPostgres();
let failed = 0;
for (const stack of stacks) {
  const result = await runStack(stack);
  if (result.error) failed++;
}
process.exit(failed === 0 ? 0 : 1);
