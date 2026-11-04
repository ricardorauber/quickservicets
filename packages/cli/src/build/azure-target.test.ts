import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMachinePlatform, forwardedClient, memoryAdapter, runAzureFunctions, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { ncrontab } from "./azure.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const config = (extra = "") => `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ ${extra} });\n`;
const DAILY = 'import { job } from "@quickservicets/core";\nexport const runs: number[] = [];\nexport default job("0 6 * * *", async () => { runs.push(1); return 1; });\n';

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

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

const freePort = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
};

/** The generated inputs of a project, for the custom handler in this process. */
async function generated(root: string): Promise<Omit<StartServiceOptions, "projectConfig">> {
  await build(root, {});
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  return { models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: dir, env: {} };
}

const quiet = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

describe("generated files", () => {
  test("host.json declares the custom handler with forwarding and no route prefix, next to http/function.json and the binary", async () => {
    const root = project("", { "jobs/reports/daily.ts": DAILY });
    expect((await cli(["build", "--target", "azure-functions"], root)).code).toBe(0);
    const dir = join(root, "dist/azure-functions");
    const host = readJson(join(dir, "host.json"));
    expect(host.customHandler).toEqual({ description: { defaultExecutablePath: "blog", workingDirectory: "", arguments: [] }, enableForwardingHttpRequest: true });
    expect(host.extensions).toEqual({ http: { routePrefix: "" } });
    expect(host.extensionBundle).toEqual({ id: "Microsoft.Azure.Functions.ExtensionBundle", version: "[4.*, 5.0.0)" });
    expect(host.functionTimeout).toBeUndefined();
    expect(readJson(join(dir, "http/function.json")).bindings).toEqual([
      { authLevel: "anonymous", type: "httpTrigger", direction: "in", name: "req", methods: ["get", "post", "put", "patch", "delete", "head", "options"], route: "{*path}" },
      { type: "http", direction: "out", name: "res" },
    ]);
    const binary = readFileSync(join(dir, "blog"));
    expect(binary.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
    expect(binary.readUInt16LE(18)).toBe(0x3e);
    expect(readJson(join(dir, "job-reports-daily/function.json"))).toEqual({ bindings: [{ name: "timer", type: "timerTrigger", direction: "in", schedule: "0 0 6 * * *" }] });
  }, 180_000);

  test("functionTimeout is written as hh:mm:ss, the extension bundle can be left out, and authLevel can be function", async () => {
    const root = project('deploy: { azure: { functionTimeout: "10m", extensionBundle: false, authLevel: "function" } }');
    expect((await cli(["build", "--target", "azure-functions"], root)).code).toBe(0);
    const host = readJson(join(root, "dist/azure-functions/host.json"));
    expect(host.functionTimeout).toBe("00:10:00");
    expect(host.extensionBundle).toBeUndefined();
    expect(readJson(join(root, "dist/azure-functions/http/function.json")).bindings[0].authLevel).toBe("function");
  }, 180_000);
});

describe("timer functions and NCRONTAB", () => {
  test("schedules become six-field NCRONTAB, and an interval that is not a step of a minute, hour or day fails", () => {
    expect(ncrontab("0 6 * * *")).toEqual({ cron: "0 0 6 * * *" });
    expect(ncrontab("30 0 6 * * *")).toEqual({ cron: "30 0 6 * * *" });
    expect(ncrontab("@daily")).toEqual({ cron: "0 0 0 * * *" });
    expect(ncrontab({ every: "10m" })).toEqual({ cron: "0 */10 * * * *" });
    expect(ncrontab({ every: "2h" })).toEqual({ cron: "0 0 */2 * * *" });
    expect(ncrontab({ every: "15s" })).toEqual({ cron: "*/15 * * * * *" });
    expect(ncrontab({ every: "7m" })).toEqual({ error: "every 7m cannot be expressed as a cron for Azure Functions; use a cron schedule" });
  });

  test("an every 7m job fails the build", async () => {
    const root = project("", { "jobs/sync.ts": 'import { job } from "@quickservicets/core";\nexport default job({ every: "7m" }, async () => {});\n' });
    const result = await cli(["build", "--target", "azure-functions"], root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["jobs/sync: every 7m cannot be expressed as a cron for Azure Functions; use a cron schedule"]);
  });

  test("a route named like a generated function fails the build", async () => {
    const root = project("", { "jobs/reports/daily.ts": DAILY, "endpoints/job-reports-daily/post.ts": "export default () => ({});\n" });
    const result = await cli(["build", "--target", "azure-functions"], root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["Route /job-reports-daily collides with the Azure function job-reports-daily; rename the route"]);
  });
});

describe("forwarded requests, invocations and failures", () => {
  test("the binary listens on FUNCTIONS_CUSTOMHANDLER_PORT, logs the invocation id as request id and takes the client from x-forwarded-for", async () => {
    const root = project(`deploy: { platform: "${buildMachinePlatform()}" }`, { "endpoints/whoami/get.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => ({ ip: req.ip, id: req.id, platform: req.platform?.name });\n' });
    expect((await cli(["build", "--target", "azure-functions"], root)).code).toBe(0);
    const port = freePort();
    const child = Bun.spawn([join(root, "dist/azure-functions/blog")], { cwd: mkdtempSync(join(tmpdir(), "qs-azure-run-")), env: { PATH: process.env.PATH ?? "", FUNCTIONS_CUSTOMHANDLER_PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    try {
      let answer: Response | undefined;
      for (let attempt = 0; attempt < 100 && !answer; attempt++) {
        answer = await fetch(`http://127.0.0.1:${port}/posts`, { headers: { "x-ms-invocation-id": "b2c5f2a1-0000" } }).catch(() => undefined);
        if (!answer) await Bun.sleep(100);
      }
      expect(answer!.status).toBe(200);
      expect(answer!.headers.get("x-request-id")).toBe("b2c5f2a1-0000");
      const who = await (await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { "x-forwarded-for": "198.51.100.7:51234", "x-ms-invocation-id": "inv-2" } })).json();
      expect(who).toEqual({ ip: "198.51.100.7", id: "inv-2", platform: "azure-functions" });
    } finally {
      child.kill();
      await child.exited;
    }
    const logs = await new Response(child.stdout).text();
    expect(logs).toContain('"requestId":"b2c5f2a1-0000"');
  }, 180_000);

  test("a timer invocation runs its job and answers the invocation shape; a failing job answers 500 with its error; an unknown name is 404", async () => {
    const root = project("", { "jobs/reports/daily.ts": DAILY, "jobs/reports/broken.ts": 'import { job } from "@quickservicets/core";\nexport default job("0 7 * * *", async () => { throw new Error("report store is down"); }, { retries: 0 });\n' });
    const inputs = await generated(root);
    const service = await runAzureFunctions({ ...inputs, projectConfig: { database: memoryAdapter(), logger: quiet().logger } as ServiceConfig, handleSigterm: false }, { port: 0, jobs: { "job-reports-daily": "reports/daily", "job-reports-broken": "reports/broken" } });
    try {
      const invoke = (name: string) => fetch(`http://127.0.0.1:${service.port}/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Data: { timer: { IsPastDue: false } }, Metadata: { sys: { MethodName: name } } }) });
      const done = await invoke("job-reports-daily");
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ Outputs: {}, Logs: ["Job reports/daily completed"], ReturnValue: { status: "completed" } });
      const { runs } = (await import(join(root, "jobs/reports/daily.ts"))) as { runs: number[] };
      expect(runs).toHaveLength(1);
      const failed = await invoke("job-reports-broken");
      expect(failed.status).toBe(500);
      const body = (await failed.json()) as { Logs: string[]; ReturnValue: unknown };
      expect(body.Logs.join("\n")).toContain("report store is down");
      expect(body.ReturnValue).toBeNull();
      expect((await invoke("nope")).status).toBe(404);
    } finally {
      await service.stop();
    }
  });

  test("the client of a forwarded request is the right-most x-forwarded-for entry, without its port", () => {
    expect(forwardedClient("10.0.0.1, 203.0.113.9:51234")).toBe("203.0.113.9");
    expect(forwardedClient("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(forwardedClient("2001:db8::2")).toBe("2001:db8::2");
    expect(forwardedClient(null)).toBeUndefined();
    expect(existsSync).toBeDefined();
  });
});
