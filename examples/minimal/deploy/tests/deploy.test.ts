import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const example = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(example, path), "utf8");
const files = () => ({
  "quickservicets.config.ts": read("quickservicets.config.ts"),
  "entities/Post.ts": read("entities/Post.ts"),
  "jobs/reports/daily.ts": read("jobs/reports/daily.ts"),
  "endpoints/ticks/sse.ts": read("endpoints/ticks/sse.ts"),
});
/** This machine as a deploy platform, so the platform binaries run here. */
const machine = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const cliEntry = join(realpathSync(join(example, "node_modules/@quickservicets/cli")), "src/index.ts");

let work: string;

/** A copy of the example, linked to the framework packages, in a folder of its own (the builds write `dist/`). */
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "qs-deploy-example-"));
  for (const entry of ["quickservicets.config.ts", "entities", "jobs", "endpoints", "migrations", "package.json"]) cpSync(join(example, entry), join(work, entry), { recursive: true });
  mkdirSync(join(work, "node_modules/@quickservicets"), { recursive: true });
  for (const name of ["core", "cli"]) symlinkSync(realpathSync(join(example, "node_modules/@quickservicets", name)), join(work, "node_modules/@quickservicets", name), "dir");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs `quickservicets <args>` in the copy; the platform binaries are built for this machine. */
function cli(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, cliEntry, ...args], { cwd: work, env: { ...process.env, QS_DEPLOY_PLATFORM: machine, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/** A folder holding only a copy of the target's output and a migrated database. */
function deployFolder(target: string): string {
  const folder = mkdtempSync(join(work, `run-${target}-`));
  cpSync(join(work, "dist", target), join(folder, target), { recursive: true });
  return folder;
}

const freePort = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
};

/** Starts a server process with a port variable and waits until `GET /posts` answers. */
async function serving(command: string[], cwd: string, variable = "PORT"): Promise<{ url: string; stop(): Promise<void> }> {
  const port = freePort();
  const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH ?? "", [variable]: String(port) }, stdout: "ignore", stderr: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await fetch(`${url}/posts`).catch(() => undefined))?.status === 200) break;
    await Bun.sleep(50);
  }
  return {
    url,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

/** A fake Lambda Runtime API handing out events and collecting the results. */
function runtimeApi(events: unknown[]) {
  const results: Record<string, unknown>[] = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/invocation/next")) {
        if (next >= events.length) return new Promise<Response>(() => {});
        return Response.json(events[next], { headers: { "lambda-runtime-aws-request-id": `r${next++}`, "lambda-runtime-deadline-ms": String(Date.now() + 30_000) } });
      }
      results.push({ path, body: JSON.parse((await request.text()) || "null") });
      return new Response(null, { status: 202 });
    },
  });
  return { api: `127.0.0.1:${server.port}`, results, stop: () => server.stop(true) };
}

test("the project serves its posts", async () => {
  const service = await startTestService({ files: files() });
  try {
    expect((await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Shipped" }) })).status).toBe(201);
    expect(((await (await service.fetch("/posts")).json()) as { total: number }).total).toBe(1);
  } finally {
    await service.stop();
  }
});

describe("each target, built and run locally", () => {
  test("the server bundle migrates and answers GET /posts from a folder holding only its output", async () => {
    expect(cli(["build", "--target", "server"]).code).toBe(0);
    const folder = deployFolder("server");
    expect(Bun.spawnSync([process.execPath, "server/server.js", "migrate"], { cwd: folder }).exitCode).toBe(0);
    const server = await serving([process.execPath, "server/server.js"], folder);
    try {
      expect(await (await fetch(`${server.url}/posts`)).json()).toMatchObject({ total: 0 });
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("the binary migrates and answers GET /posts", async () => {
    expect(cli(["build", "--target", "binary"]).code).toBe(0);
    const folder = deployFolder("binary");
    expect(Bun.spawnSync(["./binary/minimal-deploy", "migrate"], { cwd: folder }).exitCode).toBe(0);
    const server = await serving(["./binary/minimal-deploy"], folder);
    try {
      expect((await fetch(`${server.url}/posts`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("the lambda bootstrap answers 1.0 and 2.0 events and a job event, and the build warns about sse.ts without streaming", async () => {
    const built = cli(["build", "--target", "lambda"]);
    expect(built.code).toBe(0);
    expect(built.err).toContain("Warning: sse.ts routes need deploy.lambda.streaming: true on lambda");
    expect(built.err).toContain("Warning: jobs/reports/daily runs only when the platform invokes it (see the deploy guide)");
    // The database is migrated with the server bundle, which shares the migrations.
    const folder = deployFolder("lambda");
    expect(cli(["build", "--target", "server"]).code).toBe(0);
    cpSync(join(work, "dist/server"), join(folder, "server"), { recursive: true });
    expect(Bun.spawnSync([process.execPath, "server/server.js", "migrate"], { cwd: folder }).exitCode).toBe(0);
    const runtime = runtimeApi([
      { version: "2.0", rawPath: "/posts", rawQueryString: "limit=1", headers: { host: "x.lambda-url.on.aws" }, requestContext: { http: { method: "GET", sourceIp: "198.51.100.1" } } },
      { httpMethod: "POST", path: "/posts", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "From REST" }), isBase64Encoded: false, requestContext: { identity: { sourceIp: "198.51.100.2" } } },
      { quickservicets: { job: "reports/daily" } },
    ]);
    const child = Bun.spawn(["./lambda/bootstrap"], { cwd: folder, env: { PATH: process.env.PATH ?? "", AWS_LAMBDA_RUNTIME_API: runtime.api }, stdout: "ignore", stderr: "ignore" });
    try {
      for (let attempt = 0; attempt < 600 && runtime.results.length < 3; attempt++) await Bun.sleep(50);
      const [v2, v1, job] = runtime.results.map((result) => result.body as Record<string, any>);
      expect(v2!.statusCode).toBe(200);
      expect(v1!.statusCode).toBe(201);
      expect(JSON.parse(v1!.body)).toMatchObject({ title: "From REST" });
      expect(job).toEqual({ status: "completed" });
    } finally {
      child.kill();
      await child.exited;
      runtime.stop();
    }
  }, 240_000);

  test("the Azure binary answers a forwarded request and a timer invocation", async () => {
    expect(cli(["build", "--target", "azure-functions"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "dist/azure-functions/job-reports-daily/function.json"), "utf8")).bindings[0].schedule).toBe("0 0 6 * * *");
    const folder = deployFolder("azure-functions");
    expect(cli(["build", "--target", "server"]).code).toBe(0);
    cpSync(join(work, "dist/server"), join(folder, "server"), { recursive: true });
    expect(Bun.spawnSync([process.execPath, "server/server.js", "migrate"], { cwd: folder }).exitCode).toBe(0);
    const host = await serving(["./azure-functions/minimal-deploy"], folder, "FUNCTIONS_CUSTOMHANDLER_PORT");
    try {
      const forwarded = await fetch(`${host.url}/posts`, { headers: { "x-ms-invocation-id": "inv-1" } });
      expect(forwarded.headers.get("x-request-id")).toBe("inv-1");
      const timer = await fetch(`${host.url}/job-reports-daily`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Data: { timer: {} }, Metadata: {} }) });
      expect(await timer.json()).toEqual({ Outputs: {}, Logs: ["Job reports/daily completed"], ReturnValue: { status: "completed" } });
    } finally {
      await host.stop();
    }
  }, 180_000);

  test("the Cloud Run manifest and Dockerfile have the configured values", () => {
    expect(cli(["build", "--target", "cloud-run"], { QS_DEPLOY_PLATFORM: "linux-x64" }).code).toBe(0);
    const service = readFileSync(join(work, "dist/cloud-run/service.yaml"), "utf8");
    expect(service).toContain("containerConcurrency: 40");
    expect(service).toContain('autoscaling.knative.dev/minScale: "1"');
    expect(service).toContain("path: /health/live");
    expect(readFileSync(join(work, "dist/cloud-run/Dockerfile"), "utf8")).toContain('ENTRYPOINT ["/app/minimal-deploy"]');
  }, 180_000);
});
