import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors.ts";
import { definePreHook, type Repositories } from "../hooks.ts";
import type { LogEntry, Logger } from "../logger.ts";
import { withHooks } from "./pipeline.ts";
import { createServer, type Route } from "./server.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordingLogger() {
  const entries: { level: string; entry: LogEntry }[] = [];
  const logger: Logger = {
    info: (entry) => entries.push({ level: "info", entry }),
    warn: (entry) => entries.push({ level: "warn", entry }),
    error: (entry) => entries.push({ level: "error", entry }),
  };
  return { logger, entries };
}

const audit = definePreHook(() => {});
const routes: Route[] = [
  {
    method: "POST",
    path: "/users/[id]",
    handler: withHooks(async (_, req) => ({ id: req.params.id, body: await req.json(), requestId: req.id }), [{ name: "audit", args: [] }], new Map([["audit", audit]])),
  },
  { method: "GET", path: "/boom", handler: () => { throw new Error("boom"); } },
  { method: "GET", path: "/denied", handler: () => { throw new HttpError(403, "No"); } },
];

const serve = (logger: Logger, production = true) =>
  createServer({ routes, repos: {} as Repositories, config: { production, logger } });

test("one entry per request with the expected fields and level", async () => {
  const { logger, entries } = recordingLogger();
  const server = serve(logger);
  await server.fetch(new Request("http://localhost/users/abc?q=secret-query", { method: "POST", body: '{"password":"hunter2"}', headers: { authorization: "Bearer token" } }));
  await server.fetch(new Request("http://localhost/nope"));
  expect(entries).toHaveLength(2);
  const [ok, missing] = entries;
  expect(ok!.level).toBe("info");
  expect(ok!.entry).toMatchObject({ method: "POST", route: "/users/[id]", status: 200, hooks: ["audit"] });
  expect(typeof ok!.entry.durationMs).toBe("number");
  expect(new Date(ok!.entry.timestamp as string).toISOString()).toBe(ok!.entry.timestamp as string);
  expect(missing!.entry).toMatchObject({ route: null, status: 404, hooks: [] });
});

test("entries never carry bodies, query values, header values or path parameter values", async () => {
  const { logger, entries } = recordingLogger();
  await serve(logger).fetch(
    new Request("http://localhost/users/abc-param?q=secret-query", {
      method: "POST",
      body: '{"password":"hunter2"}',
      headers: { authorization: "Bearer token" },
    }),
  );
  const text = JSON.stringify(entries);
  for (const secret of ["abc-param", "secret-query", "hunter2", "Bearer token"]) expect(text).not.toContain(secret);
});

describe("request ids", () => {
  test("a valid incoming id is reused in the header, the log and req.id", async () => {
    const { logger, entries } = recordingLogger();
    const response = await serve(logger).fetch(
      new Request("http://localhost/users/1", { method: "POST", body: "{}", headers: { "x-request-id": "abc-123" } }),
    );
    expect(response.headers.get("x-request-id")).toBe("abc-123");
    expect(((await response.json()) as { requestId: string }).requestId).toBe("abc-123");
    expect(entries[0]!.entry.requestId).toBe("abc-123");
  });
  test.each(["<script>", "", "a".repeat(129)])("an invalid id %p is replaced by a UUID v7", async (header) => {
    const { logger, entries } = recordingLogger();
    const response = await serve(logger).fetch(new Request("http://localhost/nope", { headers: { "x-request-id": header } }));
    const id = response.headers.get("x-request-id")!;
    expect(id).toMatch(UUID_V7);
    expect(entries[0]!.entry.requestId).toBe(id);
  });
  test("a missing id is generated", async () => {
    const { logger } = recordingLogger();
    const response = await serve(logger).fetch(new Request("http://localhost/nope"));
    expect(response.headers.get("x-request-id")).toMatch(UUID_V7);
  });
});

test("unexpected errors produce an error entry with the stack while the response stays generic", async () => {
  const { logger, entries } = recordingLogger();
  const response = await serve(logger, true).fetch(new Request("http://localhost/boom"));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("boom");
  const failure = entries.find((item) => item.entry.error)!;
  expect(failure.level).toBe("error");
  expect(failure.entry.error).toMatchObject({ name: "Error", message: "boom" });
  expect((failure.entry.error as { stack: string }).stack).toContain("boom");
  expect(entries.find((item) => item.entry.status === 500)!.level).toBe("error");
});

test("HttpErrors do not produce an error entry", async () => {
  const { logger, entries } = recordingLogger();
  await serve(logger).fetch(new Request("http://localhost/denied"));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ level: "info", entry: { status: 403 } });
});

test("a custom logger replaces stdout", async () => {
  const { logger, entries } = recordingLogger();
  const write = process.stdout.write;
  let written = "";
  process.stdout.write = ((chunk: string) => {
    written += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await serve(logger).fetch(new Request("http://localhost/nope"));
  } finally {
    process.stdout.write = write;
  }
  expect(entries).toHaveLength(1);
  expect(written).toBe("");
});

test("a failing logger does not change the response", async () => {
  const broken: Logger = {
    info: () => {
      throw new Error("logger down");
    },
    warn: () => {},
    error: () => {},
  };
  const response = await serve(broken).fetch(new Request("http://localhost/users/1", { method: "POST", body: "{}" }));
  expect(response.status).toBe(200);
});
