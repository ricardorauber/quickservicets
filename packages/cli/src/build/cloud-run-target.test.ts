import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMachinePlatform, dockerfile, memoryAdapter, runCloudRun, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const config = (extra = "") => `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ ${extra} });\n`;
const project = (extra = "", files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "@acme/blog" }), "quickservicets.config.ts": config(extra), "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  roots.push(root);
  return root;
};

const cli = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

const read = (root: string, file: string) => readFileSync(join(root, "dist/cloud-run", file), "utf8");
const freePort = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
};

const quiet = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

async function generated(root: string): Promise<Omit<StartServiceOptions, "projectConfig">> {
  await build(root, {});
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  return { models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: dir, env: {} };
}

describe("generated files", () => {
  test("--target cloud-run writes the linux-x64 binary, a distroless Dockerfile with a non-root user, .dockerignore and service.yaml", async () => {
    const root = project();
    const built = await cli(["build", "--target", "cloud-run"], root);
    expect(built.code).toBe(0);
    const binary = readFileSync(join(root, "dist/cloud-run/blog"));
    expect(binary.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
    expect(binary.readUInt16LE(18)).toBe(0x3e);
    const docker = read(root, "Dockerfile");
    expect(docker).toContain("FROM gcr.io/distroless/cc-debian12\n");
    expect(docker).toContain("USER 10001:10001\n");
    expect(docker).toContain('ENTRYPOINT ["/app/blog"]\n');
    expect(read(root, ".dockerignore")).toContain("!blog\n");
    const service = read(root, "service.yaml");
    expect(service).toContain("apiVersion: serving.knative.dev/v1\nkind: Service\nmetadata:\n  name: blog\n");
    expect(service).toContain("      containerConcurrency: 80\n      timeoutSeconds: 300\n");
    expect(service).toContain('run.googleapis.com/cpu-throttling: "true"');
    expect(service).not.toContain("startupProbe");
    expect(built.err).toEqual([]);
  }, 180_000);
});

describe("manifest options and probes", () => {
  test("concurrency, scaling, CPU and memory reach service.yaml, a variable overrides them, and health adds both probes", async () => {
    const root = project('health: {}, deploy: { cloudRun: { concurrency: 40, minInstances: 1, maxInstances: 5, cpuAlwaysAllocated: true, memory: "1Gi", cpu: "2", timeout: "60s" } }');
    expect((await cli(["build", "--target", "cloud-run"], root)).code).toBe(0);
    const service = read(root, "service.yaml");
    expect(service).toContain("containerConcurrency: 40");
    expect(service).toContain('autoscaling.knative.dev/minScale: "1"');
    expect(service).toContain('autoscaling.knative.dev/maxScale: "5"');
    expect(service).toContain('run.googleapis.com/cpu-throttling: "false"');
    expect(service).toContain('              cpu: "2"\n              memory: 1Gi\n');
    expect(service).toContain("timeoutSeconds: 60");
    for (const probe of ["startupProbe", "livenessProbe"]) expect(service).toContain(`          ${probe}:\n            httpGet:\n              path: /health/live\n              port: 8080\n`);
    process.env.QS_DEPLOY_CLOUD_RUN_CONCURRENCY = "10";
    try {
      expect((await cli(["build", "--target", "cloud-run"], root)).code).toBe(0);
    } finally {
      delete process.env.QS_DEPLOY_CLOUD_RUN_CONCURRENCY;
    }
    expect(read(root, "service.yaml")).toContain("containerConcurrency: 10");
  }, 180_000);
});

describe("shutdown budget", () => {
  test("a stop time limit over the grace period warns, while the Cloud Run defaults fit it", async () => {
    const slow = await cli(["build", "--target", "cloud-run"], project('lifecycle: { stopTimeout: "15s" }'));
    expect(slow.err).toContain("Warning: Cloud Run stops containers 10 seconds after SIGTERM; lower lifecycle.stopTimeout or health.drainDelay");
    const defaults = await cli(["build", "--target", "cloud-run"], project("health: {}"));
    expect(defaults.err.filter((line) => line.includes("SIGTERM"))).toEqual([]);
  }, 180_000);

  test("the binary listens on PORT", async () => {
    const root = project(`deploy: { platform: "${buildMachinePlatform()}" }`);
    expect((await cli(["build", "--target", "cloud-run"], root)).code).toBe(0);
    const port = freePort();
    const child = Bun.spawn([join(root, "dist/cloud-run/blog")], { cwd: mkdtempSync(join(tmpdir(), "qs-cloud-run-")), env: { PATH: process.env.PATH ?? "", PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    try {
      let answer: Response | undefined;
      for (let attempt = 0; attempt < 100 && !answer; attempt++) {
        answer = await fetch(`http://127.0.0.1:${port}/posts`).catch(() => undefined);
        if (!answer) await Bun.sleep(100);
      }
      expect(answer!.status).toBe(200);
    } finally {
      child.kill();
      expect(await child.exited).toBe(0);
    }
  }, 180_000);
});

describe("background work by CPU allocation", () => {
  const files = { "jobs/tick.ts": 'import { job } from "@quickservicets/core";\nexport const ticks: number[] = [];\nexport default job({ every: "1s" }, async () => { ticks.push(Date.now()); });\n' };

  test("with the CPU throttled the build warns and the scheduler does not start; with it allocated the job runs", async () => {
    const warned = await cli(["build", "--target", "cloud-run"], project("", files));
    expect(warned.err).toContain("Warning: Background work needs deploy.cloudRun.cpuAlwaysAllocated: true on cloud-run");
    const allocated = await cli(["build", "--target", "cloud-run"], project("deploy: { cloudRun: { cpuAlwaysAllocated: true } }", files));
    expect(allocated.err.filter((line) => line.includes("Background work"))).toEqual([]);
    const root = project("", files);
    const inputs = await generated(root);
    const { ticks } = (await import(join(root, "jobs/tick.ts"))) as { ticks: number[] };
    const throttled = await runCloudRun({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger } as ServiceConfig, handleSigterm: false }, { port: 0, scheduledWork: false });
    await Bun.sleep(2500);
    await throttled.stop();
    expect(ticks).toHaveLength(0);
    const always = await runCloudRun({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger } as ServiceConfig, handleSigterm: false }, { port: 0, scheduledWork: true });
    const deadline = Date.now() + 10_000;
    while (ticks.length === 0 && Date.now() < deadline) await Bun.sleep(100);
    await always.stop();
    expect(ticks.length).toBeGreaterThan(0);
  }, 180_000);
});

describe("client address trust", () => {
  test("the x-forwarded-for the front end adds is req.ip by default, and the peer with trustProxy: false", async () => {
    const root = project("", { "endpoints/whoami/get.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => ({ ip: req.ip, platform: req.platform?.name });\n' });
    const inputs = await generated(root);
    for (const [trustProxy, expected] of [
      [true, "198.51.100.7"],
      [false, "127.0.0.1"],
    ] as const) {
      const service = await runCloudRun({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger } as ServiceConfig, handleSigterm: false }, { port: 0, trustProxy });
      try {
        const answer = await (await fetch(`http://127.0.0.1:${service.port}/whoami`, { headers: { "x-forwarded-for": "198.51.100.7" } })).json();
        expect(answer).toEqual({ ip: expected, platform: "cloud-run" });
      } finally {
        await service.stop();
      }
    }
  });
});

describe("the shared Dockerfile writer", () => {
  test("the runtime stage, a build stage before it, a health check, and the target's Dockerfile equal to its output", async () => {
    const runtime = dockerfile({ artifact: "app", base: "distroless", user: 10001, port: 8080 });
    expect(runtime.dockerfile).toBe(
      [
        "# Generated by quickservicets build. Do not edit.",
        "FROM gcr.io/distroless/cc-debian12",
        "WORKDIR /app",
        "COPY --chown=10001:10001 app /app/app",
        "USER 10001:10001",
        "ENV PORT=8080",
        "EXPOSE 8080",
        'ENTRYPOINT ["/app/app"]',
        "",
      ].join("\n"),
    );
    const staged = dockerfile({ artifact: "app", base: "distroless", user: 10001, port: 8080, buildStage: { commands: ["bun install --frozen-lockfile", "bun run quickservicets build --target binary"], output: "dist/binary/app" }, healthcheck: ["/app/app", "health"] });
    const lines = staged.dockerfile.split("\n");
    expect(lines.slice(1, 6)).toEqual(["FROM oven/bun:1.4.2 AS build", "WORKDIR /src", "COPY . .", "RUN bun install --frozen-lockfile", "RUN bun run quickservicets build --target binary"]);
    expect(staged.dockerfile).toContain("COPY --from=build --chown=10001:10001 /src/dist/binary/app /app/app\n");
    expect(staged.dockerfile).toContain('HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["/app/app","health"]\n');
    const slim = dockerfile({ artifact: "server", base: "bun-slim", port: 3000, entrypoint: ["bun", "/app/server/server.js"] });
    expect(slim.dockerfile).toContain("FROM oven/bun:1.4.2-slim\n");
    expect(slim.dockerfile).toContain('ENTRYPOINT ["bun","/app/server/server.js"]\n');
    const root = project();
    expect((await cli(["build", "--target", "cloud-run"], root)).code).toBe(0);
    expect(read(root, "Dockerfile")).toBe(dockerfile({ artifact: "blog", base: "distroless", user: 10001, port: 8080 }).dockerfile);
  }, 180_000);
});
