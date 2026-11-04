import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMachinePlatform, createServiceHandler, handleLambdaEvent, lambdaRequest, lambdaResult, memoryAdapter, runLambda, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const project = (config: string, files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "blog" }), "quickservicets.config.ts": config, "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  roots.push(root);
  return root;
};

const config = (extra = "") => `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ ${extra} });\n`;

const cli = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

/** The CPU an ELF executable is for: `aarch64` or `x86-64`. */
const elfMachine = (file: string) => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
  return { 0xb7: "aarch64", 0x3e: "x86-64" }[bytes.readUInt16LE(18)];
};

/** A fake Lambda Runtime API: hands out the events in order and records what the function posts back. */
function fakeRuntime(events: unknown[]) {
  const posted: { id: string; kind: string; headers: Headers; body: Uint8Array }[] = [];
  let next = 0;
  let notify: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/2018-06-01/runtime/invocation/next") {
        if (next >= events.length) return new Promise<Response>(() => {});
        const id = `request-${next}`;
        return Response.json(events[next++], { headers: { "lambda-runtime-aws-request-id": id, "lambda-runtime-deadline-ms": String(Date.now() + 30_000), "lambda-runtime-invoked-function-arn": "arn:aws:lambda:us-east-1:1:function:blog" } });
      }
      const match = /^\/2018-06-01\/runtime\/(?:invocation\/([^/]+)\/(response|error)|init\/(error))$/.exec(path);
      if (!match) return new Response("not found", { status: 404 });
      posted.push({ id: match[1] ?? "init", kind: match[2] ?? "init-error", headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      notify?.();
      return new Response(null, { status: 202 });
    },
  });
  return {
    api: `127.0.0.1:${server.port}`,
    posted,
    /** Resolves once `count` results were posted. */
    async results(count: number, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (posted.length < count && Date.now() < deadline) await new Promise<void>((resolve) => ((notify = resolve), setTimeout(resolve, 200)));
      return posted;
    },
    stop: () => server.stop(true),
  };
}

const json = (entry: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(entry.body)) as Record<string, any>;

/** A 2.0 (HTTP API and function URL) event. */
const v2 = (method: string, rawPath: string, rawQueryString = "", extra: Record<string, unknown> = {}) => ({
  version: "2.0",
  rawPath,
  rawQueryString,
  headers: { host: "abc.lambda-url.us-east-1.on.aws" },
  requestContext: { http: { method, sourceIp: "198.51.100.20" } },
  ...extra,
});

/** Builds a project and returns the inputs its generated server passes to startService. */
async function generated(files: Record<string, string>): Promise<Omit<StartServiceOptions, "projectConfig">> {
  const root = project(config(), files);
  await build(root, {});
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  return { models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: dir, env: {} };
}

const recorder = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

const handlerOf = (inputs: Omit<StartServiceOptions, "projectConfig">, projectConfig: Partial<ServiceConfig> = {}, logger = recorder().logger) =>
  createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger, ...projectConfig } as ServiceConfig, handleSigterm: false });

const context = { awsRequestId: "c6af9ac6", deadlineMs: Date.now() + 30_000 };

describe("the bootstrap and its package", () => {
  test("--target lambda writes bootstrap and function.zip for arm64, and for x86_64 with QS_DEPLOY_LAMBDA_ARCHITECTURE", async () => {
    const root = project(config());
    expect((await cli(["build", "--target", "lambda"], root)).code).toBe(0);
    expect(elfMachine(join(root, "dist/lambda/bootstrap"))).toBe("aarch64");
    const unzipped = mkdtempSync(join(tmpdir(), "qs-lambda-zip-"));
    roots.push(unzipped);
    expect(Bun.spawnSync(["unzip", "-q", join(root, "dist/lambda/function.zip"), "-d", unzipped]).exitCode).toBe(0);
    expect(statSync(join(unzipped, "bootstrap")).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(unzipped, "bootstrap")).equals(readFileSync(join(root, "dist/lambda/bootstrap")))).toBe(true);
    process.env.QS_DEPLOY_LAMBDA_ARCHITECTURE = "x86_64";
    try {
      expect((await cli(["build", "--target", "lambda"], root)).code).toBe(0);
    } finally {
      delete process.env.QS_DEPLOY_LAMBDA_ARCHITECTURE;
    }
    expect(elfMachine(join(root, "dist/lambda/bootstrap"))).toBe("x86-64");
  }, 180_000);
});

describe("the Runtime API loop", () => {
  test("a bootstrap for this machine answers a 2.0 event against a fake Runtime API", async () => {
    const root = project(config(`deploy: { platform: "${buildMachinePlatform()}" }`));
    expect((await cli(["build", "--target", "lambda"], root)).code).toBe(0);
    const runtime = fakeRuntime([v2("GET", "/posts", "limit=1")]);
    const child = Bun.spawn([join(root, "dist/lambda/bootstrap")], { cwd: mkdtempSync(join(tmpdir(), "qs-lambda-run-")), env: { PATH: process.env.PATH ?? "", AWS_LAMBDA_RUNTIME_API: runtime.api }, stdout: "pipe", stderr: "pipe" });
    try {
      const [result] = await runtime.results(1);
      expect(result!.kind).toBe("response");
      const answer = json(result!);
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(answer.body)).toMatchObject({ data: [], total: 0, limit: 1 });
      expect(answer.headers["x-request-id"]).toBe("request-0");
    } finally {
      child.kill();
      await child.exited;
      runtime.stop();
    }
  }, 180_000);

  test("a failing setup is reported to the init error endpoint and the bootstrap exits", async () => {
    const root = project(config(`deploy: { platform: "${buildMachinePlatform()}" }`), {
      "features/broken/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "broken", enabledByDefault: true, setup() { throw new Error("no database credentials"); } });\n',
    });
    expect((await cli(["build", "--target", "lambda"], root)).code).toBe(0);
    const runtime = fakeRuntime([]);
    const child = Bun.spawn([join(root, "dist/lambda/bootstrap")], { env: { PATH: process.env.PATH ?? "", AWS_LAMBDA_RUNTIME_API: runtime.api }, stdout: "pipe", stderr: "pipe" });
    try {
      const [report] = await runtime.results(1);
      expect(report!.kind).toBe("init-error");
      expect(json(report!).errorMessage).toContain("no database credentials");
      expect(await child.exited).toBe(1);
    } finally {
      child.kill();
      runtime.stop();
    }
  }, 180_000);
});

describe("request conversion", () => {
  test("a 1.0 REST event with multi-value query parameters and a base64 body creates the record", async () => {
    const event = {
      httpMethod: "POST",
      path: "/posts",
      multiValueHeaders: { "content-type": ["application/json"], host: ["api.example.com"] },
      multiValueQueryStringParameters: { tag: ["a", "b"] },
      body: Buffer.from(JSON.stringify({ title: "From REST" })).toString("base64"),
      isBase64Encoded: true,
      requestContext: { identity: { sourceIp: "203.0.113.4" } },
    };
    const converted = lambdaRequest(event);
    expect(converted).toMatchObject({ format: "1.0", multiValue: true, clientIp: "203.0.113.4" });
    expect(new URL(converted.request.url).searchParams.getAll("tag")).toEqual(["a", "b"]);
    const handler = handlerOf(await generated({}));
    try {
      const result = (await handleLambdaEvent(handler, event, context)) as Record<string, any>;
      expect(result.statusCode).toBe(201);
      expect(result.multiValueHeaders["content-type"]).toEqual([expect.stringContaining("application/json")]);
      expect(JSON.parse(result.body)).toMatchObject({ title: "From REST" });
    } finally {
      await handler.stop();
    }
  });

  test("an ALB event's client address is the right-most x-forwarded-for entry", async () => {
    const inputs = await generated({ "endpoints/whoami/get.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => ({ ip: req.ip, platform: req.platform?.name });\n' });
    const handler = handlerOf(inputs);
    try {
      const event = { httpMethod: "GET", path: "/whoami", headers: { "x-forwarded-for": "10.0.0.1, 192.0.2.44" }, body: "", isBase64Encoded: false, requestContext: { elb: { targetGroupArn: "arn" } } };
      expect(lambdaRequest(event).clientIp).toBe("192.0.2.44");
      const result = (await handleLambdaEvent(handler, event, context)) as Record<string, any>;
      expect(JSON.parse(result.body)).toEqual({ ip: "192.0.2.44", platform: "lambda" });
    } finally {
      await handler.stop();
    }
  });
});

describe("response mapping", () => {
  test("a PNG is returned base64, and two set-cookie headers become two 2.0 cookies", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const image = await lambdaResult(new Response(png, { headers: { "content-type": "image/png" } }), "2.0", false);
    expect(image).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: Buffer.from(png).toString("base64") });
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const cookies = await lambdaResult(new Response("{}", { headers }), "2.0", false);
    expect(cookies.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(cookies.isBase64Encoded).toBe(false);
    expect((cookies.headers as Record<string, string>)["set-cookie"]).toBeUndefined();
    const v1 = await lambdaResult(new Response("{}", { headers }), "1.0", true);
    expect((v1.multiValueHeaders as Record<string, string[]>)["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("a download endpoint answers through the handler with a base64 body", async () => {
    const inputs = await generated({ "endpoints/logo/get.ts": 'export default () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });\n' });
    const handler = handlerOf(inputs);
    try {
      const result = (await handleLambdaEvent(handler, v2("GET", "/logo"), context)) as Record<string, any>;
      expect(result).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
    } finally {
      await handler.stop();
    }
  });
});

describe("jobs, unsupported events and the size limit", () => {
  test("a job event runs the job, an unknown event fails, and a 7 MB response becomes a 500", async () => {
    const inputs = await generated({
      "jobs/reports/daily.ts": 'import { job } from "@quickservicets/core";\nexport const runs: number[] = [];\nexport default job("0 6 * * *", async () => { runs.push(Date.now()); return 1; });\n',
      "endpoints/huge/get.ts": 'export default () => new Response("x".repeat(7 * 1024 * 1024), { headers: { "content-type": "text/plain" } });\n',
    });
    const { entries, logger } = recorder();
    const handler = handlerOf(inputs, {}, logger);
    try {
      expect(await handleLambdaEvent(handler, { quickservicets: { job: "reports/daily" } }, context)).toEqual({ status: "completed" });
      const { runs } = (await import(join(inputs.generatedDir!, "../jobs/reports/daily.ts"))) as { runs: number[] };
      expect(runs).toHaveLength(1);
      await expect(handleLambdaEvent(handler, { foo: 1 }, context)).rejects.toThrow("Unsupported Lambda event");
      const huge = (await handleLambdaEvent(handler, v2("GET", "/huge"), context, { logger })) as Record<string, any>;
      expect(huge.statusCode).toBe(500);
      expect(JSON.parse(huge.body)).toEqual({ error: { code: "INTERNAL_ERROR", message: "Response is larger than the 6 MB Lambda limit" } });
      expect(entries.find((entry) => entry.message === "lambda.response.too-large")).toMatchObject({ route: "/huge" });
    } finally {
      await handler.stop();
    }
  });
});

describe("streaming", () => {
  const sse = { "endpoints/ticks/sse.ts": 'import { defineSse } from "@quickservicets/core";\nexport default defineSse((stream) => { stream.send({ tick: 1 }); stream.send({ tick: 2 }); stream.close(); });\n' };

  test("with streaming on, an SSE route streams its events through the streaming response mode", async () => {
    const root = project(config("realtime: {}"), sse);
    await build(root, {});
    const dir = join(root, ".generated");
    const inputs = {
      models: (await import(join(dir, "models.ts"))).models,
      ...(await import(join(dir, "routes.ts"))),
      jobs: (await import(join(dir, "jobs.ts"))).jobs,
      ...(await import(join(dir, "features.ts"))),
      generatedDir: dir,
      env: {},
    };
    const runtime = fakeRuntime([v2("GET", "/ticks")]);
    try {
      await runLambda({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger, realtime: {} } as ServiceConfig, handleSigterm: false }, { runtimeApi: runtime.api, streaming: true, invocations: 1 });
      const [result] = runtime.posted;
      expect(result!.headers.get("lambda-runtime-function-response-mode")).toBe("streaming");
      const bytes = result!.body;
      const delimiter = bytes.findIndex((_byte, index) => bytes.subarray(index, index + 8).every((value) => value === 0));
      const prelude = JSON.parse(new TextDecoder().decode(bytes.subarray(0, delimiter)));
      expect(prelude).toMatchObject({ statusCode: 200, headers: { "content-type": expect.stringContaining("text/event-stream") } });
      const stream = new TextDecoder().decode(bytes.subarray(delimiter + 8));
      expect(stream).toContain('data: {"tick":1}');
      expect(stream).toContain('data: {"tick":2}');
    } finally {
      runtime.stop();
    }
  });

  test("without streaming the lambda build warns about sse.ts routes", async () => {
    const root = project(config("realtime: {}"), sse);
    const result = await cli(["build", "--target", "lambda"], root);
    expect(result.code).toBe(0);
    expect(result.err).toContain("Warning: sse.ts routes need deploy.lambda.streaming: true on lambda");
    const streaming = project(config("realtime: {}, deploy: { lambda: { streaming: true } }"), sse);
    expect((await cli(["build", "--target", "lambda"], streaming)).err.filter((line) => line.includes("sse.ts"))).toEqual([]);
  }, 180_000);
});
