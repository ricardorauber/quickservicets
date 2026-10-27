import { afterEach, describe, expect, test } from "bun:test";
import type { DisconnectFilter } from "../http/socket.ts";
import type { SocketEnvelope, SocketTransport, SocketTransportContext } from "../http/socket-transport.ts";

/** What `runSocketTransportContract` takes besides the transport factory. */
export interface SocketTransportContractOptions {
  /** Shown in the test titles (default `transport`). */
  name?: string;
  /**
   * False for a transport that keeps everything in one process (like the local one): only the checks that apply to a
   * single instance run (default true).
   */
  crossProcess?: boolean;
  /** Drops an instance's connection, as a network failure would; the reconnection check is skipped without it. */
  drop?: (transport: SocketTransport) => void | Promise<void>;
  /** How long a check waits for a delivery, in milliseconds (default 2000). */
  timeout?: number;
}

const silent = { info() {}, warn() {}, error() {} };

/** An instance started with recording handlers. */
interface Started {
  transport: SocketTransport;
  messages: SocketEnvelope[];
  disconnects: (DisconnectFilter & { origin?: string })[];
}

async function started(create: () => SocketTransport | Promise<SocketTransport>): Promise<Started> {
  const transport = await create();
  const messages: SocketEnvelope[] = [];
  const disconnects: (DisconnectFilter & { origin?: string })[] = [];
  const context: SocketTransportContext = { onMessage: (envelope) => void messages.push(envelope), onDisconnect: (filter) => void disconnects.push(filter), logger: silent };
  await transport.start(context);
  return { transport, messages, disconnects };
}

async function eventually(check: () => boolean, timeout: number): Promise<boolean> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return true;
    await Bun.sleep(10);
  }
  return check();
}

/** Records the timers created while `fn` runs and those still pending, so a stopped transport can be checked. */
async function trackingTimers<T>(fn: () => Promise<T>): Promise<{ result: T; pending: () => number }> {
  const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  const live = new Set<unknown>();
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = saved.setTimeout((...values: unknown[]) => {
      live.delete(handle);
      handler(...values);
    }, ms, ...args);
    live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = saved.setInterval(handler, ms, ...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearTimeout = ((handle: unknown) => (live.delete(handle), saved.clearTimeout(handle as never))) as typeof clearTimeout;
  globalThis.clearInterval = ((handle: unknown) => (live.delete(handle), saved.clearInterval(handle as never))) as typeof clearInterval;
  try {
    const result = await fn();
    return { result, pending: () => live.size };
  } finally {
    Object.assign(globalThis, saved);
  }
}

const envelope = (origin: string, extra: Partial<SocketEnvelope> = {}): SocketEnvelope => ({ origin, room: `contract:${crypto.randomUUID().slice(0, 8)}`, data: "hello", ...extra });

/**
 * Registers `bun:test` tests that check a `SocketTransport` with two instances from `create`: delivery between them,
 * origins kept so a process skips its own envelopes, `except`, disconnect fan-out, binary payloads, stopping without
 * leaking timers, and reconnection after a dropped connection. With `crossProcess: false` only the checks that apply
 * to one instance run.
 */
export function runSocketTransportContract(create: () => SocketTransport | Promise<SocketTransport>, options: SocketTransportContractOptions = {}): void {
  const name = options.name ?? "transport";
  const timeout = options.timeout ?? 2000;
  const crossProcess = options.crossProcess ?? true;
  const opened: Started[] = [];
  const pair = async () => {
    const a = await started(create);
    const b = await started(create);
    opened.push(a, b);
    // A transport may need a moment to subscribe before it receives.
    await Bun.sleep(50);
    return [a, b] as const;
  };

  describe(`SocketTransport contract: ${name}`, () => {
    afterEach(async () => {
      for (const instance of opened.splice(0)) await instance.transport.stop();
    });

    test("start, publish, disconnect and stop resolve", async () => {
      const a = await started(create);
      opened.push(a);
      await a.transport.publish(envelope("a"));
      await a.transport.disconnect({ user: "u1", origin: "a" });
    });

    test("stop leaves no timer running", async () => {
      const { pending } = await trackingTimers(async () => {
        const a = await started(create);
        await a.transport.publish(envelope("a"));
        await a.transport.stop();
      });
      await Bun.sleep(20);
      expect(pending()).toBe(0);
    });

    if (!crossProcess) return;

    test("an envelope published by one instance reaches the other with its room, data and origin", async () => {
      const [a, b] = await pair();
      const sent = envelope("process-a");
      await a.transport.publish(sent);
      expect(await eventually(() => b.messages.some((message) => message.room === sent.room), timeout)).toBe(true);
      expect(b.messages.find((message) => message.room === sent.room)).toEqual(sent);
    });

    test("an instance receives its own envelopes only with its origin, so it can skip them", async () => {
      const [a, b] = await pair();
      const sent = envelope("process-a");
      await a.transport.publish(sent);
      await eventually(() => b.messages.some((message) => message.room === sent.room), timeout);
      for (const message of a.messages.filter((received) => received.room === sent.room)) expect(message.origin).toBe("process-a");
    });

    test("except is delivered with the envelope", async () => {
      const [a, b] = await pair();
      const sent = envelope("process-a", { except: "socket-1" });
      await a.transport.publish(sent);
      expect(await eventually(() => b.messages.some((message) => message.room === sent.room), timeout)).toBe(true);
      expect(b.messages.find((message) => message.room === sent.room)?.except).toBe("socket-1");
    });

    test("a disconnect reaches the other instance", async () => {
      const [a, b] = await pair();
      await a.transport.disconnect({ user: "u1", code: 4401, reason: "Session revoked", origin: "process-a" });
      expect(await eventually(() => b.disconnects.some((filter) => filter.user === "u1"), timeout)).toBe(true);
      expect(b.disconnects.find((filter) => filter.user === "u1")).toMatchObject({ user: "u1", code: 4401, reason: "Session revoked" });
    });

    test("binary payloads arrive intact", async () => {
      const [a, b] = await pair();
      const data = Buffer.from(new Uint8Array([0, 1, 2, 250, 255])).toString("base64");
      const sent = envelope("process-a", { data, binary: true });
      await a.transport.publish(sent);
      expect(await eventually(() => b.messages.some((message) => message.room === sent.room), timeout)).toBe(true);
      expect(b.messages.find((message) => message.room === sent.room)).toMatchObject({ data, binary: true });
    });

    const reconnects = options.drop ? test : test.skip;
    reconnects("an instance whose connection dropped reconnects and receives again", async () => {
      const [a, b] = await pair();
      await options.drop!(b.transport);
      const deadline = Date.now() + Math.max(timeout, 15_000);
      let delivered = false;
      while (!delivered && Date.now() < deadline) {
        const sent = envelope("process-a");
        await a.transport.publish(sent);
        delivered = await eventually(() => b.messages.some((message) => message.room === sent.room), 250);
      }
      expect(delivered).toBe(true);
    }, 30_000);
  });
}

/**
 * Transports that deliver between app instances of one process, for tests: every transport of the same set receives
 * what another publishes; `drop` cuts one for 100 milliseconds.
 */
export function inProcessTransports(): { transport(): SocketTransport & { drop(): void } } {
  const members = new Set<{ context?: SocketTransportContext; dropped: boolean }>();
  const send = (from: object, deliver: (context: SocketTransportContext) => void) => {
    for (const member of members) {
      if (member === from || member.dropped || !member.context) continue;
      // Delivered asynchronously, like a network would.
      queueMicrotask(() => member.context && deliver(member.context));
    }
  };
  return {
    transport() {
      const member: { context?: SocketTransportContext; dropped: boolean } = { dropped: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        start(context) {
          member.context = context;
          members.add(member);
        },
        publish: (envelope) => send(member, (context) => context.onMessage(structuredClone(envelope))),
        disconnect: (filter) => send(member, (context) => context.onDisconnect(structuredClone(filter))),
        stop() {
          clearTimeout(timer);
          members.delete(member);
          member.context = undefined;
        },
        drop() {
          member.dropped = true;
          timer = setTimeout(() => (member.dropped = false), 100);
        },
      };
    },
  };
}
