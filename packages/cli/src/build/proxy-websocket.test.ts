import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

/** What the upstream saw of each handshake, and how its sockets closed. */
const handshakes: { path: string; headers: Record<string, string> }[] = [];
const upstreamCloses: { code: number; reason: string }[] = [];
const upstreamFrames: (string | number)[] = [];

/** A local WebSocket upstream: it echoes frames, closes on request, sends a large frame, and refuses /live/refuse. */
function wsUpstream() {
  return Bun.serve<{ path: string }, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      handshakes.push({ path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) });
      if (url.pathname.endsWith("/refuse")) return new Response("no", { status: 403 });
      const offered = request.headers.get("sec-websocket-protocol");
      // The upstream chooses the last subprotocol offered, so the test sees it was the upstream's choice.
      const protocol = offered?.split(",").at(-1)?.trim();
      if (server.upgrade(request, { data: { path: url.pathname }, ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}) })) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        if (ws.data.path.endsWith("/greet")) ws.send("hello");
      },
      message(ws, message) {
        upstreamFrames.push(typeof message === "string" ? message : message.byteLength);
        if (message === "close-4000") return ws.close(4000, "done");
        if (message === "big") return void ws.send(new Uint8Array(2_000_000));
        ws.send(message);
      },
      close(_ws, code, reason) {
        upstreamCloses.push({ code, reason });
      },
    },
  });
}

let upstream: ReturnType<typeof wsUpstream>;
/** A TCP server that accepts connections and never answers, for handshake timeouts. */
let silent: { port: number; stop(force?: boolean): void };
beforeAll(() => {
  upstream = wsUpstream();
  silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
});
afterAll(() => {
  upstream.stop(true);
  silent.stop(true);
});
const at = (port: number | undefined) => `http://127.0.0.1:${port}`;

const CONFIG = (extra: string, head = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
${head}
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
  },
  ${extra}
});
`;
const logs = () => ((globalThis as { socketLogs?: Record<string, unknown>[] }).socketLogs ??= []);
const live = (extra = "", target = at(upstream.port)) => `proxy: { routes: { live: { path: "/live/*", target: "${target}", websocket: true${extra} } } },`;

const running: TestService[] = [];
const extra: { stop(): unknown }[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  for (const server of extra.splice(0)) await server.stop();
  handshakes.length = 0;
  upstreamCloses.length = 0;
  upstreamFrames.length = 0;
  logs().length = 0;
  delete (globalThis as { proxyErrors?: unknown }).proxyErrors;
});

async function start(config: string, options: { head?: string; env?: Record<string, string>; files?: Record<string, string>; auth?: boolean } = {}) {
  const service = await startTestService({
    files: { "quickservicets.config.ts": CONFIG(config, options.head), ...options.files },
    ...(options.env ? { env: options.env } : {}),
    ...(options.auth ? { auth: testAuth() } : {}),
  });
  running.push(service);
  return service;
}

/** A WebSocket client recording frames and its close. */
function client(url: string, options: { headers?: Record<string, string>; protocols?: string[] } = {}) {
  const ws = new WebSocket(url, { headers: options.headers ?? {}, ...(options.protocols ? { protocols: options.protocols } : {}) } as never);
  ws.binaryType = "arraybuffer";
  const frames: (string | number)[] = [];
  ws.addEventListener("message", (event) => frames.push(typeof event.data === "string" ? event.data : (event.data as ArrayBuffer).byteLength));
  const done = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
  });
  return {
    ws,
    frames,
    done,
    opened,
    async wait(count: number) {
      for (let tries = 0; tries < 400 && frames.length < count; tries++) await Bun.sleep(5);
      return frames;
    },
  };
}
const wsBase = async (service: TestService) => (await service.listen()).url.replace("http", "ws");
const UPGRADE = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
const message = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;
/** Waits until `check` holds, for at most two seconds. */
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 400 && !check(); tries++) await Bun.sleep(5);
};

describe("options", () => {
  test("websocket needs realtime, and its variable turns it on per route", async () => {
    await expect(start(live())).rejects.toThrow("proxy.routes.live.websocket needs realtime: {} in quickservicets.config.ts");
    const service = await start(`realtime: {}, proxy: { routes: { live: { path: "/live/*", target: "${at(upstream.port)}" } } },`, { env: { QS_PROXY_ROUTES_LIVE_WEBSOCKET: "true" } });
    const socket = client(`${await wsBase(service)}/live/echo`);
    expect(await socket.opened).toBe(true);
    socket.ws.close();
    // A plain GET on the route is still proxied as HTTP: the upstream answers it 426.
    expect((await service.fetch("/live/plain")).status).toBe(426);
  });
});

describe("checks and the upstream handshake", () => {
  test("an anonymous upgrade answers 401 without an upstream connection; the signed identity reaches proxyIdentity; client identity headers never pass", async () => {
    const behind = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter, proxyIdentity } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, realtime: {}, auth: { providers: [proxyIdentity({ secret: "gateway-secret-1" })] } });
`,
        "endpoints/live/me/ws.ts": `import { defineSocket } from "@quickservicets/core";
export default defineSocket({ open: (ws) => ws.send(JSON.stringify({ user: (ws.user as { id?: string } | undefined)?.id ?? null })), message: (ws, data) => ws.send(data) });
`,
      },
    });
    running.push(behind);
    const behindUrl = (await behind.listen()).url;
    const gateway = await start(
      `auth: {}, realtime: {}, proxy: {
    identity: { secret: "gateway-secret-1" },
    beforeProxy: [({ upstream }) => void upstream.headers.set("x-gateway", "1")],
    routes: { live: { path: "/live/*", target: "${behindUrl}", websocket: true, auth: "required" }, raw: { path: "/raw/*", target: "${at(upstream.port)}", websocket: true, rewrite: "/[...rest]" } },
  },`,
      { auth: true },
    );
    const anonymous = await gateway.fetch("/live/me", { headers: UPGRADE });
    expect(anonymous.status).toBe(401);
    const base = await wsBase(gateway);
    const signed = client(`${base}/live/me`, { headers: { "x-test-user": "u1" } });
    expect(await signed.opened).toBe(true);
    expect(await signed.wait(1)).toEqual([JSON.stringify({ user: "u1" })]);
    signed.ws.close();

    const raw = client(`${base}/raw/echo?x=1`, { headers: { "x-test-user": "u2", "x-user-id": "admin", cookie: "a=1", authorization: "Bearer t" } });
    expect(await raw.opened).toBe(true);
    const seen = handshakes.at(-1)!;
    expect(seen.path).toBe("/echo?x=1");
    expect(seen.headers["x-user-id"]).toBe("u2");
    expect(seen.headers["x-gateway"]).toBe("1");
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-quickservicets-identity"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    raw.ws.close();
  });

  test("a foreign origin answers 403 and a second socket over maxConnections answers 503", async () => {
    const service = await start(`realtime: { websockets: { maxConnections: 1 } }, ${live()}`);
    const evil = await service.fetch("/live/echo", { headers: { ...UPGRADE, origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(await message(evil)).toBe("Origin not allowed");
    const first = client(`${await wsBase(service)}/live/echo`);
    expect(await first.opened).toBe(true);
    const second = await service.fetch("/live/echo", { headers: UPGRADE });
    expect(second.status).toBe(503);
    expect(handshakes).toHaveLength(1);
    first.ws.close();
  });
});

describe("upgrade ordering and failures", () => {
  test("the client gets the upstream's subprotocol; a closed port and a refusing upstream answer 502, a silent one 504 after the timeout, with onProxyError", async () => {
    const service = await start(
      `realtime: {}, proxy: {
    onProxyError: [({ route }) => void ((globalThis as any).proxyErrors ??= []).push(route)],
    routes: {
      live: { path: "/live/*", target: "${at(upstream.port)}", websocket: true },
      closed: { path: "/closed/*", target: "http://127.0.0.1:1", websocket: true },
      silent: { path: "/silent/*", target: "${at(silent.port)}", websocket: true, timeout: "300ms" },
    },
  },`,
    );
    const socket = client(`${await wsBase(service)}/live/echo`, { protocols: ["chat.v1", "chat.v2"] });
    expect(await socket.opened).toBe(true);
    expect(socket.ws.protocol).toBe("chat.v2");
    expect(handshakes.at(-1)!.headers["sec-websocket-protocol"]).toBe("chat.v1, chat.v2");
    socket.ws.close();

    const closed = await service.fetch("/closed/x", { headers: UPGRADE });
    expect(closed.status).toBe(502);
    expect(await message(closed)).toBe("Upstream request failed");
    const refused = await service.fetch("/live/refuse", { headers: UPGRADE });
    expect(refused.status).toBe(502);
    const started = performance.now();
    const slow = await service.fetch("/silent/x", { headers: UPGRADE });
    expect(slow.status).toBe(504);
    expect(await message(slow)).toBe("Upstream request timed out");
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect((globalThis as { proxyErrors?: unknown[] }).proxyErrors).toEqual(["closed", "live", "silent"]);
  });
});

describe("frames and limits", () => {
  test("text and binary frames are echoed, frames sent before the client opened arrive, a 2 MB frame closes both with 1009, and silence closes with 1001", async () => {
    const service = await start(`realtime: { websockets: { idleTimeout: "1s" } }, ${live()}`);
    const base = await wsBase(service);
    const greeted = client(`${base}/live/greet`);
    expect(await greeted.opened).toBe(true);
    greeted.ws.send("text");
    greeted.ws.send(new Uint8Array([1, 2, 3]));
    expect(await greeted.wait(3)).toEqual(["hello", "text", 3]);
    greeted.ws.close();

    const big = client(`${base}/live/echo`);
    await big.opened;
    big.ws.send(new Uint8Array(2_000_000));
    expect(await big.done).toEqual({ code: 1009, reason: "Message too big" });
    await until(() => upstreamCloses.length > 1);
    expect(upstreamCloses.at(-1)!.code).toBe(1009);

    const down = client(`${base}/live/echo`);
    await down.opened;
    down.ws.send("big");
    expect((await down.done).code).toBe(1009);

    const quiet = client(`${base}/live/echo`);
    await quiet.opened;
    const started = performance.now();
    expect(await quiet.done).toEqual({ code: 1001, reason: "Idle timeout" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe("closes", () => {
  test("the upstream's 4000 done reaches the client, the client's close reaches the upstream, and an upstream that dies closes the client with 1014", async () => {
    const service = await start(`realtime: {}, ${live()}`);
    const base = await wsBase(service);
    const done = client(`${base}/live/echo`);
    await done.opened;
    done.ws.send("close-4000");
    expect(await done.done).toEqual({ code: 4000, reason: "done" });

    const leaving = client(`${base}/live/echo`);
    await leaving.opened;
    leaving.ws.close(4001, "bye");
    await until(() => upstreamCloses.some((entry) => entry.code === 4001));
    expect(upstreamCloses).toContainEqual({ code: 4001, reason: "bye" });

    const doomed = wsUpstream();
    extra.push({ stop: () => doomed.stop(true) });
    const other = await start(`realtime: {}, ${live("", at(doomed.port))}`);
    const dying = client(`${await wsBase(other)}/live/echo`);
    await dying.opened;
    doomed.stop(true);
    expect(await dying.done).toEqual({ code: 1014, reason: "Bad gateway" });
  });
});

describe("logging, shutdown and forward()", () => {
  test("a closed socket logs one entry with proxy, counts and code; shutdown closes with 1001; forward() upgrades from an endpoint", async () => {
    const service = await start(`realtime: {}, ${live()}`, {
      files: {
        "endpoints/stream/get.ts": `import { forward, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => forward(req, "live");
`,
      },
    });
    const base = await wsBase(service);
    const socket = client(`${base}/live/echo`);
    await socket.opened;
    socket.ws.send("a");
    socket.ws.send("b");
    await socket.wait(2);
    socket.ws.close(1000, "ok");
    await until(() => logs().some((entry) => entry.status === 101));
    expect(logs().find((entry) => entry.status === 101)).toMatchObject({ method: "GET", proxy: "live", messagesIn: 2, messagesOut: 2, closeCode: 1000 });

    const streamed = client(`${base}/stream`);
    expect(await streamed.opened).toBe(true);
    streamed.ws.send("through forward");
    expect(await streamed.wait(1)).toEqual(["through forward"]);
    expect(handshakes.at(-1)!.path).toBe("/stream");

    await service.stop();
    running.length = 0;
    expect(await streamed.done).toEqual({ code: 1001, reason: "Server shutting down" });

    const plain = await start(`realtime: {}, proxy: { routes: { live: { path: "/live/*", target: "${at(upstream.port)}" } } },`, {
      files: {
        "endpoints/stream/get.ts": `import { forward, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => { try { return forward(req, "live"); } catch (error) { return { error: (error as Error).message }; } };
`,
      },
    });
    expect(await (await plain.fetch("/stream", { headers: UPGRADE })).json()).toEqual({ error: "forward() received a WebSocket upgrade, but no proxy route sets websocket: true" });
  });
});

describe("the WebSocket handler", () => {
  test("Bun.serve gets a websocket handler only when a route proxies sockets", async () => {
    const serve = spyOn(Bun, "serve");
    try {
      const plain = await start(`realtime: {}, proxy: { routes: { live: { path: "/live/*", target: "${at(upstream.port)}" } } },`);
      await plain.listen();
      expect((serve.mock.calls.at(-1)![0] as { websocket?: unknown }).websocket).toBeUndefined();
      await plain.stop();
      running.length = 0;
      const sockets = await start(`realtime: {}, ${live()}`);
      await sockets.listen();
      expect((serve.mock.calls.at(-1)![0] as { websocket?: unknown }).websocket).toBeDefined();
    } finally {
      serve.mockRestore();
    }
  });
});
