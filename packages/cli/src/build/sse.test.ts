import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).sseLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).sseLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).sseLogs ??= []).push(entry),
  }`;
const config = (realtime = "realtime: {}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${realtime ? `, ${realtime}` : ""}, ${LOGGER} });
`;
const CLOCK = `import { defineSse } from "@quickservicets/core";

/** The time, every 20 milliseconds. */
export default defineSse((stream) => {
  const timer = setInterval(() => stream.send({ now: Date.now() }), 20);
  stream.signal.addEventListener("abort", () => clearInterval(timer));
});
`;
const FILES = {
  "quickservicets.config.ts": config(),
  "endpoints/clock/sse.ts": CLOCK,
  "endpoints/last/sse.ts": `import { defineSse } from "@quickservicets/core";
export default defineSse((stream, _repos, req) => stream.send({ lastEventId: req.lastEventId ?? null }));
`,
  "endpoints/failing/sse.ts": `import { defineSse } from "@quickservicets/core";
export default defineSse(async () => { throw new Error("handler broke"); });
`,
  "endpoints/private/sse.ts": `import { defineSse } from "@quickservicets/core";
/** @authorized */
export default defineSse((stream) => { (globalThis as any).privateOpened = true; stream.send("secret"); });
`,
  "hooks/authorized.ts": `import { definePreHook, HttpError } from "@quickservicets/core";
export default definePreHook((_repos, req) => {
  if (!req.headers.get("authorization")) throw new HttpError(401, "Sign in first");
});
`,
};
const logs = () => ((globalThis as { sseLogs?: Record<string, unknown>[] }).sseLogs ??= []);
afterEach(() => {
  logs().length = 0;
});

const decoder = new TextDecoder();
async function readUntil(response: Response, done: (text: string) => boolean) {
  const reader = response.body!.getReader();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value);
  }
  return { text, reader };
}
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(5);
};

describe("sse.ts endpoints", () => {
  test("GET /clock streams messages with the SSE headers; get.ts next to sse.ts fails the build naming both", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const response = await service.fetch("/clock");
      expect(response.status).toBe(200);
      expect(Object.fromEntries(["content-type", "cache-control", "connection", "x-accel-buffering"].map((name) => [name, response.headers.get(name)]))).toEqual({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const { text, reader } = await readUntil(response, (read) => read.split("\n\n").length > 2);
      expect(text).toMatch(/^data: \{"now":\d+\}\n\ndata: \{"now":\d+\}\n\n/);
      await reader.cancel();
    } finally {
      await service.stop();
    }
    const conflict = createLinkedProject({ ...FILES, "endpoints/clock/get.ts": "export default () => ({});\n" });
    expect((await failure(() => build(conflict))).message).toBe("endpoints/clock/get.ts and endpoints/clock/sse.ts: a folder has one GET route; keep one of them");
  });

  test("without realtime the build fails; a default export other than defineSse fails the build", async () => {
    const without = createLinkedProject({ ...FILES, "quickservicets.config.ts": config("") });
    expect((await failure(() => build(without))).message).toContain("endpoints/clock/sse.ts needs realtime: {} in quickservicets.config.ts");
    const plain = createLinkedProject({ ...FILES, "endpoints/clock/sse.ts": "export default () => ({});\n" });
    expect((await failure(() => build(plain))).message).toContain("endpoints/clock/sse.ts: must default-export defineSse(...)");
  });

  test("a pre-hook that throws answers its error and never opens the stream", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const refused = await service.fetch("/private");
      expect([refused.status, refused.headers.get("content-type")]).toEqual([401, "application/json"]);
      expect((globalThis as { privateOpened?: boolean }).privateOpened).toBeUndefined();
      const allowed = await service.fetch("/private", { headers: { authorization: "Bearer x" } });
      const { text, reader } = await readUntil(allowed, (read) => read.includes("secret"));
      expect(text).toBe("data: secret\n\n");
      await reader.cancel();
    } finally {
      await service.stop();
    }
  });

  test("a disconnect writes the request log with the message count; a rejecting handler closes the stream and is logged", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const { reader } = await readUntil(await service.fetch("/clock"), (read) => read.split("\n\n").length > 3);
      await reader.cancel();
      await until(() => logs().some((entry) => entry.route === "/clock"));
      const entry = logs().find((logged) => logged.route === "/clock")!;
      expect(entry.messages as number).toBeGreaterThanOrEqual(3);
      expect(typeof entry.durationMs).toBe("number");
      const failed = await service.fetch("/failing");
      expect(failed.status).toBe(200);
      const { text } = await readUntil(failed, () => false);
      expect(text).toBe("");
      expect(logs()).toContainEqual(expect.objectContaining({ message: "sse.handler.failed", error: expect.objectContaining({ message: "handler broke" }) }));
    } finally {
      await service.stop();
    }
  });

  test("req.lastEventId reads the header, else the query parameter", async () => {
    const service = await startTestService({ files: FILES });
    try {
      for (const [init, path, expected] of [[{ headers: { "last-event-id": "42" } }, "/last", "42"], [{}, "/last?lastEventId=9", "9"], [{}, "/last", null]] as const) {
        const { text, reader } = await readUntil(await service.fetch(path, init), (read) => read.includes("\n\n"));
        expect(text).toBe(`data: ${JSON.stringify({ lastEventId: expected })}\n\n`);
        await reader.cancel();
      }
    } finally {
      await service.stop();
    }
  });

  test("a third stream beyond maxStreams answers 503, and stopping the service closes the open streams", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("realtime: { sse: { maxStreams: 2 } }") } });
    let stopped = false;
    try {
      const open = [await service.fetch("/clock"), await service.fetch("/clock")];
      const third = await service.fetch("/clock");
      expect([third.status, third.headers.get("retry-after"), ((await third.json()) as { error: { message: string } }).error.message]).toEqual([503, "5", "Too many open streams"]);
      const ended = open.map((response) => readUntil(response, () => false));
      await service.stop();
      stopped = true;
      // Each body ends: the shutdown closed its stream.
      for (const read of ended) expect(typeof (await read).text).toBe("string");
    } finally {
      if (!stopped) await service.stop();
    }
  });

  test("OpenAPI documents the route as text/event-stream; without realtime a request creates no timer", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const document = JSON.parse(readFileSync(join(service.root, ".generated/openapi.json"), "utf8"));
      expect(Object.keys(document.paths["/clock"].get.responses["200"].content)).toEqual(["text/event-stream"]);
    } finally {
      await service.stop();
    }
    const plain = await startTestService({ files: { "quickservicets.config.ts": config(""), "entities/Note.ts": "export type Note = { text: string };\n" } });
    const original = globalThis.setInterval;
    const timers: unknown[] = [];
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      timers.push(args);
      return original(...args);
    }) as typeof setInterval;
    try {
      await plain.fetch("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a" }) });
      await plain.fetch("/notes");
      expect(timers).toEqual([]);
    } finally {
      globalThis.setInterval = original;
      await plain.stop();
    }
  });
});

