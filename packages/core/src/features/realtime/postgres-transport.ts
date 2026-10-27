import { safeLog, type DatabaseAdapter, type DisconnectFilter, type Logger, type SocketEnvelope, type SocketTransport, type SocketTransportContext } from "../public.ts";

/** What `postgresTransport` takes. */
export interface PostgresTransportOptions {
  /** The PostgreSQL adapter, with `listen` and `notify`. */
  adapter: Pick<DatabaseAdapter, "listen" | "notify">;
  /** The notification channel. */
  channel: string;
  /** The largest payload sent, in bytes; larger envelopes are delivered locally only. */
  maxPayload: number;
  /** The clock, in epoch milliseconds (default `Date.now`). */
  now?: () => number;
}

/** A PostgreSQL socket transport, with the state its health check reads. */
export interface PostgresTransport extends SocketTransport {
  /** Whether the listening connection is subscribed now. */
  readonly connected: boolean;
  /**
   * Checks the listening connection end to end: sends a notification to itself and waits up to `timeoutMs` for it;
   * rejects while the connection is down.
   */
  probe(timeoutMs?: number): Promise<void>;
}

/** The first and the longest wait between reconnection attempts. */
const BACKOFF = { first: 100, max: 10_000 };
/** How often a room's oversized envelopes are logged. */
const TOO_LARGE_EVERY = 60_000;

type Wire = { kind: "message"; envelope: SocketEnvelope } | { kind: "disconnect"; filter: DisconnectFilter & { origin?: string } } | { kind: "probe"; id: string };

/** The default channel, suffixed with the default schema so two deployments in one database do not mix. */
export function socketChannel(channel: string, schema: string | undefined): string {
  if (!schema) return channel;
  return `${channel}_${schema.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 63);
}

/**
 * Delivers room messages across workers and replicas with PostgreSQL `LISTEN` and `NOTIFY` on the project's database:
 * one dedicated listening connection, compact JSON envelopes under the payload limit, reconnection with backoff, and
 * at-most-once delivery (nothing sent while the connection was down arrives).
 */
export function postgresTransport(options: PostgresTransportOptions): PostgresTransport {
  const now = options.now ?? Date.now;
  let context: SocketTransportContext | undefined;
  let logger: Logger = { info() {}, warn() {}, error() {} };
  let unlisten: (() => Promise<void>) | undefined;
  let connected = false;
  let stopped = false;
  let listens = 0;
  /** When the connection was last known to work: a notification or an acknowledged LISTEN. */
  let lastAlive = now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const tooLargeAt = new Map<string, number>();
  const probes = new Map<string, () => void>();

  const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) => safeLog(logger, level, { timestamp: new Date().toISOString(), message, ...fields });

  const receive = (payload: string) => {
    lastAlive = now();
    let wire: Wire;
    try {
      wire = JSON.parse(payload) as Wire;
      if (typeof wire !== "object" || wire === null) throw new Error("not an object");
    } catch {
      log("warn", "realtime.transport.invalid", { channel: options.channel });
      return;
    }
    if (wire.kind === "probe" && typeof wire.id === "string") probes.get(wire.id)?.();
    else if (wire.kind === "message" && typeof wire.envelope?.room === "string" && typeof wire.envelope.data === "string") context?.onMessage(wire.envelope);
    else if (wire.kind === "disconnect" && typeof wire.filter === "object" && wire.filter !== null) context?.onDisconnect(wire.filter);
    else log("warn", "realtime.transport.invalid", { channel: options.channel });
  };

  const onListen = () => {
    const at = now();
    listens += 1;
    // A second acknowledgment means the connection dropped and was subscribed again.
    if (listens > 1) log("info", "realtime.transport.reconnected", { channel: options.channel, downtimeMs: Math.max(0, at - lastAlive) });
    connected = true;
    lastAlive = at;
  };

  /** Subscribes; a failure schedules the next attempt with exponential backoff and jitter, until the transport stops. */
  const connect = async (attempt: number, downSince?: number): Promise<void> => {
    if (stopped) return;
    try {
      unlisten = await options.adapter.listen!(options.channel, receive, onListen);
      if (stopped) {
        await unlisten();
        unlisten = undefined;
        return;
      }
      if (downSince !== undefined && listens <= 1) log("info", "realtime.transport.reconnected", { channel: options.channel, downtimeMs: Math.max(0, now() - downSince) });
    } catch (error) {
      connected = false;
      const wait = Math.min(BACKOFF.max, BACKOFF.first * 2 ** attempt);
      const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
      log("error", "realtime.transport.failed", { operation: "listen", channel: options.channel, retryInMs: jittered, error: { message: (error as Error)?.message ?? String(error) } });
      if (stopped) return;
      retry = setTimeout(() => {
        retry = undefined;
        void connect(attempt + 1, downSince ?? now());
      }, jittered);
    }
  };

  /** Sends a wire message, or refuses one over the payload limit; resolves whether it was sent. */
  const send = async (wire: Wire, room?: string): Promise<boolean> => {
    const payload = JSON.stringify(wire);
    const size = Buffer.byteLength(payload);
    if (size > options.maxPayload) {
      const key = room ?? "-";
      const at = now();
      if ((tooLargeAt.get(key) ?? -Infinity) + TOO_LARGE_EVERY <= at) {
        tooLargeAt.set(key, at);
        log("warn", "realtime.transport.too-large", { room: key, size, maxPayload: options.maxPayload });
      }
      return false;
    }
    await options.adapter.notify!(options.channel, payload);
    return true;
  };

  return {
    get connected() {
      return connected;
    },
    async start(ctx) {
      context = ctx;
      logger = ctx.logger;
      stopped = false;
      // A first subscription that fails is retried in the background; startup goes on.
      await connect(0);
    },
    async publish(envelope) {
      await send({ kind: "message", envelope }, envelope.room);
    },
    async disconnect(filter) {
      await send({ kind: "disconnect", filter });
    },
    async probe(timeoutMs = 1000) {
      if (!connected) throw new Error("The listening connection is down");
      const id = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            probes.set(id, resolve);
            void send({ kind: "probe", id }).catch(() => {});
          }),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The listening connection did not answer")), timeoutMs))),
        ]);
      } finally {
        clearTimeout(timer);
        probes.delete(id);
      }
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      connected = false;
      const current = unlisten;
      unlisten = undefined;
      context = undefined;
      await current?.();
    },
  };
}
