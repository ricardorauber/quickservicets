import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createServer as createTlsServer, type SecureContextOptions, type TLSSocket } from "node:tls";
import { clientFromPeer, setClientCertificate } from "../client-certificates.ts";

/** What serving with client certificates needs: the TLS material, the trusted CAs, the mode and the request handler. */
export interface ClientCertificateServerOptions {
  port: number;
  /** The server certificate, key, passphrase and version options. */
  tls: { cert: string; key: string; ca?: string[]; passphrase?: string; secureOptions?: number };
  /** The authorities client certificates must chain to. */
  clientCa: string[];
  /** Refuses clients without a valid certificate in the handshake (`required`), or lets them through (`optional`). */
  required: boolean;
  /** Seconds an idle connection stays open, 0 for never. */
  idleTimeout?: number;
  /** Answers one request; `peer` is the client's address. */
  fetch(request: Request, peer: string): Promise<Response>;
}

/** A server listening with client certificates. */
export interface ClientCertificateServer {
  port: number;
  /** Replaces the certificates and authorities new connections use, keeping the open ones. */
  setSecureContext(options: SecureContextOptions): void;
  /** Stops accepting connections; with `close`, ends the open ones too. */
  stop(close?: boolean): Promise<void>;
}

/** A standard `Request` for an incoming Node request, with its body streamed. */
function requestOf(incoming: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  return new Request(`https://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, { method, headers, body, signal, ...(body ? { duplex: "half" } : {}) } as RequestInit);
}

/** Writes a `Response` to a Node response, streaming its body with backpressure. */
async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  outgoing.writeHead(response.status, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  for await (const chunk of response.body) {
    if (outgoing.destroyed) break;
    if (!outgoing.write(chunk)) await new Promise<void>((resolve) => outgoing.once("drain", resolve));
  }
  outgoing.end();
}

/**
 * Serves HTTPS through `node:tls` and `node:http`, because `Bun.serve` does not give the peer certificate of a request:
 * the handshake asks for a client certificate checked against `clientCa`, each request gets the verified one as
 * `req.client`, and responses stream back.
 */
export function listenWithClientCertificates(options: ClientCertificateServerOptions): ClientCertificateServer {
  const http = createHttpServer((incoming, outgoing) => {
    const socket = incoming.socket as TLSSocket;
    const controller = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    const request = requestOf(incoming, controller.signal);
    if (socket.authorized) {
      const peer = socket.getPeerCertificate(true);
      if (peer && Object.keys(peer).length > 0) setClientCertificate(request, () => clientFromPeer(peer));
    }
    options
      .fetch(request, socket.remoteAddress ?? "unknown")
      .then((response) => writeResponse(response, outgoing))
      .catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
  });
  if (options.idleTimeout !== undefined) http.keepAliveTimeout = options.idleTimeout * 1000;
  const tls = createTlsServer(
    {
      cert: options.tls.cert,
      key: options.tls.key,
      ...(options.tls.passphrase !== undefined ? { passphrase: options.tls.passphrase } : {}),
      ...(options.tls.secureOptions !== undefined ? { secureOptions: options.tls.secureOptions } : {}),
      ca: options.clientCa,
      requestCert: true,
      rejectUnauthorized: options.required,
    },
    (socket) => http.emit("connection", socket),
  );
  const sockets = new Set<TLSSocket>();
  tls.on("secureConnection", (socket: TLSSocket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // Handshake failures (a missing or untrusted certificate in required mode) close that connection only.
  tls.on("tlsClientError", () => {});
  tls.listen(options.port);
  const address = tls.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    setSecureContext: (context) => tls.setSecureContext({ ...context, ca: context.ca ?? options.clientCa } as SecureContextOptions),
    stop(close = false) {
      return new Promise<void>((resolve) => {
        tls.close(() => resolve());
        if (close) for (const socket of sockets) socket.destroy();
        else for (const socket of sockets) if (!(socket as unknown as { _httpMessage?: unknown })._httpMessage) socket.end();
      });
    },
  };
}
