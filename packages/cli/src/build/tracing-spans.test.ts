import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mockHttp } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";
import { recordingTracer } from "../../../core/src/tracing-test-support.ts";

type Tracer = ReturnType<typeof recordingTracer>;
const holder = globalThis as { testTracer?: Tracer };

const CONFIG = (extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  realtime: {},
  ${extra}
});
`;
/** A project feature that sets the test's tracer, when the test gives one. */
const TRACER_FEATURE = `import { defineFeature, setTracer } from "@quickservicets/core";
export default defineFeature({
  key: "tracer",
  enabledByDefault: true,
  setup() {
    const tracer = (globalThis as any).testTracer;
    if (tracer) setTracer(tracer);
  },
});
`;
const USER = `export type User = { name: string };\n`;
const BOOM = `export default () => { throw new Error("boom"); };\n`;
const BILLING = `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.http.service("billing").get("/x").send();
`;
const OWN = `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.http.service("billing").get("/x").header("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").send();
`;
const STREAM = `import { defineSse } from "@quickservicets/core";
export default defineSse((stream) => { stream.send("one"); stream.send("two"); });
`;
const ECHO = `import { defineSocket } from "@quickservicets/core";
export default defineSocket({ message: (ws, data) => ws.send(data) });
`;
const SERVICES = `http: { services: { billing: { url: "https://billing.test", retry: { backoff: "1ms" } } } },`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  delete holder.testTracer;
});

async function start(extra = "", traced = true) {
  const tracer = traced ? recordingTracer() : undefined;
  if (tracer) holder.testTracer = tracer;
  const service = await startTestService({
    files: {
      "quickservicets.config.ts": CONFIG(extra),
      "features/tracer/index.ts": TRACER_FEATURE,
      "entities/User.ts": USER,
      "endpoints/boom/get.ts": BOOM,
      "endpoints/bill/get.ts": BILLING,
      "endpoints/own/get.ts": OWN,
      "endpoints/stream/sse.ts": STREAM,
      "endpoints/echo/ws.ts": ECHO,
    },
  });
  running.push(service);
  return { service, tracer: tracer! };
}

const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 400 && !check(); tries++) await Bun.sleep(5);
};

describe("server spans", () => {
  test("one server span per request, named after the matched route, continuing a valid traceparent", async () => {
    const { service, tracer } = await start();
    const created = (await (await service.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ann" }) })).json()) as { id: string };
    tracer.spans.length = 0;
    const response = await service.fetch(`/users/${created.id}`, { headers: { "user-agent": "tests/1" } });
    expect(response.status).toBe(200);
    const servers = tracer.spans.filter((span) => span.kind === "server");
    expect(servers).toHaveLength(1);
    const span = servers[0]!;
    expect(span.name).toBe("GET /users/[id]");
    expect(span.ended).toBe(true);
    expect(span.parent).toBeNull();
    expect(span.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/users/[id]",
      "http.response.status_code": 200,
      "url.path": `/users/${created.id}`,
      "url.scheme": "http",
      "server.address": "localhost",
      "user_agent.original": "tests/1",
      "quickservicets.request_id": response.headers.get("x-request-id")!,
    });

    tracer.spans.length = 0;
    expect((await service.fetch("/nowhere")).status).toBe(404);
    expect(tracer.spans[0]!.name).toBe("GET");
    expect(tracer.spans[0]!.attributes["http.response.status_code"]).toBe(404);

    tracer.spans.length = 0;
    await service.fetch("/users", { headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "v=1" } });
    expect(tracer.spans[0]!.parent).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1, traceState: "v=1" });
    expect(tracer.spans[0]!.context().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    tracer.spans.length = 0;
    await service.fetch("/users", { headers: { traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" } });
    expect(tracer.spans[0]!.parent).toBeNull();
    expect(tracer.spans[0]!.context().traceId).not.toBe("00000000000000000000000000000000");
  });

  test("5xx sets the status error with one exception, 4xx leaves it unset, and no attribute holds credentials or query values", async () => {
    const { service, tracer } = await start();
    expect((await service.fetch("/boom")).status).toBe(500);
    const failed = tracer.spans.find((span) => span.kind === "server")!;
    expect(failed.status).toEqual({ code: "error" });
    expect(failed.events.filter((event) => event.name === "exception")).toHaveLength(1);
    expect((failed.exceptions[0] as Error).message).toBe("boom");

    tracer.spans.length = 0;
    await service.fetch("/missing");
    expect(tracer.spans[0]!.status).toBeUndefined();
    expect(tracer.spans[0]!.events).toEqual([]);

    tracer.spans.length = 0;
    await service.fetch("/users?token=abc", { headers: { authorization: "Bearer s3cr3t-value" } });
    const values = JSON.stringify(tracer.spans.map((span) => span.attributes));
    expect(values).not.toContain("abc");
    expect(values).not.toContain("s3cr3t-value");
  });
});

describe("streams and sockets", () => {
  test("an SSE span ends when the stream closes, and socket messages run in spans linked to the upgrade span", async () => {
    const { service, tracer } = await start();
    const { url } = await service.listen();
    const controller = new AbortController();
    const response = await fetch(`${url}/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const sse = tracer.spans.find((span) => span.name === "GET /stream")!;
    expect(sse.ended).toBe(false);
    controller.abort();
    await until(() => sse.ended);
    expect(sse.ended).toBe(true);
    expect(sse.events.map((event) => event.name)).toContain("sse.message");

    const ws = new WebSocket(`${url.replace("http", "ws")}/echo`);
    const received: string[] = [];
    ws.addEventListener("message", (event) => received.push(String(event.data)));
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send("a");
    ws.send("b");
    await until(() => received.length === 2);
    const upgrade = tracer.spans.find((span) => span.name === "GET /echo")!;
    const messages = tracer.named("WS /echo message");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.kind).toBe("internal");
      expect(message.links[0]!.context).toEqual(upgrade.context());
      expect(message.ended).toBe(true);
    }
    expect(upgrade.ended).toBe(false);
    ws.close(1000);
    await until(() => upgrade.ended);
    expect(upgrade.events.find((event) => event.name === "websocket.closed")?.attributes).toEqual({ "websocket.close.code": 1000 });
  });
});

describe("client spans", () => {
  test("each attempt runs in a client span under the server span and the call carries its traceparent", async () => {
    const { service, tracer } = await start(SERVICES);
    const mock = mockHttp();
    try {
      mock.service("billing").on("GET", "/x").reply(200, { ok: true });
      mock.service("billing").on("GET", "/x").reply(503).once();
      expect((await service.fetch("/bill")).status).toBe(200);
      const server = tracer.spans.find((span) => span.kind === "server")!;
      const clients = tracer.spans.filter((span) => span.kind === "client");
      expect(clients).toHaveLength(2);
      for (const client of clients) {
        expect(client.name).toBe("GET");
        expect(client.parent).toEqual(server.context());
        expect(client.attributes).toMatchObject({ "http.request.method": "GET", "server.address": "billing.test", "server.port": 443, "url.full": "https://billing.test/x", "quickservicets.http.service": "billing" });
      }
      expect(clients[0]!.attributes["http.request.resend_count"]).toBeUndefined();
      expect(clients[0]!.status).toEqual({ code: "error" });
      expect(clients[0]!.attributes["http.response.status_code"]).toBe(503);
      expect(clients[1]!.attributes["http.request.resend_count"]).toBe(1);
      expect(clients[1]!.status).toBeUndefined();
      expect(mock.calls.map((call) => call.headers.traceparent)).toEqual(clients.map((client) => `00-${client.context().traceId}-${client.context().spanId}-01`));

      mock.calls.length = 0;
      await service.fetch("/own");
      expect(mock.calls[0]!.headers.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

      tracer.spans.length = 0;
      mock.service("billing").on("GET", "/x").fail("network");
      await service.fetch("/bill");
      const failed = tracer.spans.filter((span) => span.kind === "client");
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]!.attributes["error.type"]).toBe("NETWORK");
      expect(failed[0]!.status).toEqual({ code: "error" });
    } finally {
      mock.restore();
    }
  });
});

describe("without a tracer", () => {
  test("no span is created and no traceparent header is read or written", async () => {
    const { service } = await start(SERVICES, false);
    const mock = mockHttp();
    const get = spyOn(Headers.prototype, "get");
    const set = spyOn(Headers.prototype, "set");
    try {
      mock.service("billing").on("GET", "/x").reply(200, { ok: true });
      expect((await service.fetch("/bill", { headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } })).status).toBe(200);
      expect(get.mock.calls.some(([name]) => /^trace(parent|state)$/i.test(String(name)))).toBe(false);
      expect(set.mock.calls.some(([name]) => /^trace(parent|state)$/i.test(String(name)))).toBe(false);
      expect(mock.calls[0]!.headers.traceparent).toBeUndefined();
    } finally {
      get.mockRestore();
      set.mockRestore();
      mock.restore();
    }
  });
});
