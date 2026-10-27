import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { defineSocket } from "./http/socket.ts";
import { socketServer, type SocketHooks } from "./features/realtime/sockets.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";

const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

describe("variables", () => {
  test("every websockets option has its variable", () => {
    const env = {
      QS_REALTIME_WEBSOCKETS_ENABLED: "true",
      QS_REALTIME_WEBSOCKETS_MAX_CONNECTIONS: "5",
      QS_REALTIME_WEBSOCKETS_MAX_MESSAGE_SIZE: "64KB",
      QS_REALTIME_WEBSOCKETS_IDLE_TIMEOUT: "30s",
      QS_REALTIME_WEBSOCKETS_MESSAGES: "2/s",
      QS_REALTIME_WEBSOCKETS_ORIGINS: "https://a.example,https://b.example",
      QS_REALTIME_WEBSOCKETS_MAX_ROOMS: "7",
      QS_REALTIME_WEBSOCKETS_TRANSPORT: "local",
      QS_REALTIME_WEBSOCKETS_POSTGRES_CHANNEL: "my_sockets",
    };
    const options = resolveConfig({ database: memoryAdapter(), realtime: {} } as ServiceConfig, env).features.find((feature) => feature.key === "realtime")!.options;
    expect(options.websockets).toMatchObject({
      enabled: true,
      maxConnections: 5,
      maxMessageSize: "64KB",
      idleTimeout: "30s",
      messages: "2/s",
      origins: ["https://a.example", "https://b.example"],
      maxRooms: 7,
      transport: "local",
      postgres: { channel: "my_sockets" },
    });
  });

  test("QS_REALTIME_WEBSOCKETS_ENABLED=false makes ws.ts routes answer 404", async () => {
    const app = await startTestApp({ config: { realtime: {} }, env: { QS_REALTIME_WEBSOCKETS_ENABLED: "false" }, endpoints: [{ path: "/echo", kind: "websocket", handler: defineSocket({ message() {} }) }] });
    running.push(app);
    expect(await errorOf(await app.fetch("/echo", { headers: upgrade }))).toMatchObject({ status: 404, message: "Route not found" });
  });
});

describe("hooks", () => {
  test("a feature adds a hook through ctx.feature(realtime).addHook, and an unknown name is refused", async () => {
    registerNative(
      defineFeature({
        key: "socket-guard",
        docs: { summary: "Adds a socket hook." },
        enabledByDefault: true,
        after: ["realtime"],
        setup(ctx) {
          ctx.feature("realtime").addHook("beforeConnect", ({ req }) => {
            if (req.headers.get("x-blocked")) throw new Error("blocked");
          });
          expect(() => ctx.feature("realtime").addHook("beforeNothing" as never, (() => {}) as never)).toThrow("Unknown hook beforeNothing of realtime.websockets");
        },
      }),
    );
    registered.push("socket-guard");
    const app = await startTestApp({ config: { realtime: {} }, endpoints: [{ path: "/echo", kind: "websocket", handler: defineSocket({ message() {} }) }] });
    running.push(app);
    expect((await app.fetch("/echo", { headers: { ...upgrade, "x-blocked": "1" } })).status).toBe(500);
    expect((await app.fetch("/echo", { headers: upgrade })).status).toBe(400);
  });

  test("a socket without hooks makes no hook call per frame", async () => {
    let iterations = 0;
    const watched = <T>() => new Proxy([] as T[], { get: (target, key, receiver) => (key === Symbol.iterator && (iterations += 1), Reflect.get(target, key, receiver)) });
    const hooks: SocketHooks = { beforeConnect: watched(), afterConnect: watched(), beforeMessage: watched(), beforeSubscribe: watched(), beforePublish: watched(), onClose: watched() };
    const server = socketServer({ maxConnections: 10, maxMessageSize: 1024, idleTimeout: 60, messages: { count: 1000, windowMs: 1000 }, origins: undefined, proxy: undefined, logger: { info() {}, warn() {}, error() {} }, maxRooms: 10, tenantRooms: false, hooks });
    let received = 0;
    const definition = defineSocket({ message: () => void (received += 1) });
    const { OpenSocket } = await import("./features/realtime/sockets.ts");
    const socket = new OpenSocket(definition, { params: {}, query: new URLSearchParams(), user: undefined, tenant: undefined, repos: {}, log: { info() {}, warn() {}, error() {} }, req: {} as never }, "/echo", "r1", { topicOf: (room) => room, maxRooms: 10, publishFrom() {}, mayJoin: () => true }, undefined, { maxMessageSize: 1024, messages: { count: 1000, windowMs: 1000 } });
    const ws = { data: { socket }, readyState: 1, send: () => 0, close() {}, subscribe() {}, unsubscribe() {}, publish: () => 0, isSubscribed: () => false };
    for (let index = 0; index < 100; index++) await server.handler.message!(ws as never, `frame ${index}`);
    expect(received).toBe(100);
    expect(iterations).toBe(0);
  });
});
