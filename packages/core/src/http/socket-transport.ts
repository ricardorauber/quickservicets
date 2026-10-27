import { hostname } from "node:os";
import type { Logger } from "../logger.ts";
import type { DisconnectFilter } from "./socket.ts";

/** One room message between processes. */
export interface SocketEnvelope {
  /** The process that published it, `<hostname>:<pid>:<random>`; it skips its own envelopes. */
  origin: string;
  /** The room's topic, already in its tenant's namespace. */
  room: string;
  /** The encoded frame: text, or base64 with `binary`. */
  data: string;
  /** True when `data` is a binary frame in base64. */
  binary?: boolean;
  /** The id of a socket of the room that does not receive it. */
  except?: string;
}

/** What a transport hands to `start`: where received envelopes and disconnects go. */
export interface SocketTransportContext {
  onMessage(envelope: SocketEnvelope): void;
  onDisconnect(filter: DisconnectFilter & { origin?: string }): void;
  logger: Logger;
}

/**
 * Delivers room messages and disconnects to the sockets of every worker and replica. The `realtime` native publishes
 * locally through Bun and hands each envelope to the transport; envelopes it receives from other processes are
 * published to the local sockets of their room. Delivery is at most once.
 */
export interface SocketTransport {
  start(context: SocketTransportContext): void | Promise<void>;
  publish(envelope: SocketEnvelope): void | Promise<void>;
  disconnect(filter: DisconnectFilter & { origin?: string }): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** A process id for envelopes: the host name, the process id and a random part, unique per socket server. */
export function transportOrigin(): string {
  return `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

/** The transport of a single worker: every socket is local, so nothing travels. */
export function localTransport(): SocketTransport {
  return {
    start() {},
    publish() {},
    disconnect() {},
    stop() {},
  };
}

/** Encodes a frame for an envelope: text as it is, bytes in base64. */
export function encodeEnvelopeData(frame: string | Uint8Array): { data: string; binary?: true } {
  return typeof frame === "string" ? { data: frame } : { data: Buffer.from(frame).toString("base64"), binary: true };
}

/** The frame of an envelope: text as it is, base64 decoded to bytes. */
export function decodeEnvelopeData(envelope: Pick<SocketEnvelope, "data" | "binary">): string | Uint8Array {
  return envelope.binary ? new Uint8Array(Buffer.from(envelope.data, "base64")) : envelope.data;
}
