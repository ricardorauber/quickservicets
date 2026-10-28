import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:tls";
import { loadServerTls, logServerCertificate, memoryAdapter, resolveConfig, startService, type LogEntry, type RunningService, type ServiceConfig } from "@quickservicets/core";
import { createTestCertificates } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();
const silent = { info() {}, warn() {}, error() {} };

/** A port nothing listens on now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

const config = (tls: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, server: { tls: ${tls} }, ${extra} });
`;

async function serve(tls: string, extra = "") {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(tls, extra), "entities/Post.ts": "export type Post = { title: string };\n", "endpoints/where/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ url: req.raw.url });\n' } });
  running.push(service);
  const { port } = await service.listen();
  return { service, base: `https://localhost:${port}`, port };
}
const trusting = { tls: { ca: certs.ca.certPem } } as RequestInit;

/** Opens a TLS connection limited to one version, resolving the protocol or the error. */
const handshake = (port: number, maxVersion: "TLSv1.2" | "TLSv1.3") =>
  new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, servername: "localhost", ca: certs.ca.certPem, minVersion: "TLSv1.2", maxVersion }, () => {
      resolve(`ok ${socket.getProtocol()}`);
      socket.end();
    });
    socket.on("error", (error: Error) => resolve(`error ${error.message}`));
  });

describe("config shape and variables", () => {
  test("paths and PEM text load the same, ca takes a list, and QS_SERVER_TLS_* variables enable TLS without a config entry", () => {
    const fromFiles = loadServerTls({ cert: certs.server.cert, key: certs.server.key, ca: [certs.ca.cert, certs.otherCa.certPem] });
    const fromText = loadServerTls({ cert: certs.server.certPem, key: certs.server.keyPem });
    expect(fromFiles.cert).toBe(fromText.cert);
    expect(fromFiles.info.fingerprint256).toBe(fromText.info.fingerprint256);
    expect(fromFiles.ca).toHaveLength(2);
    expect(fromFiles.files).toEqual({ cert: certs.server.cert, key: certs.server.key, ca: [certs.ca.cert] });
    expect(fromFiles.minVersion).toBe("TLSv1.2");

    const env = { QS_SERVER_TLS_CERT: certs.server.cert, QS_SERVER_TLS_KEY: certs.server.key, QS_SERVER_TLS_MIN_VERSION: "TLSv1.3", QS_SERVER_TLS_EXPIRY_WARNING: "7d" };
    const resolved = resolveConfig({ database: memoryAdapter(), logger: silent } as ServiceConfig, env);
    expect(resolved.server.tls).toEqual({ cert: certs.server.cert, key: certs.server.key, minVersion: "TLSv1.3", expiryWarning: "7d" });
  });
});

describe("startup validation", () => {
  test("a missing key file, a certificate given as the key and a mismatched pair fail with messages without PEM text", () => {
    const failure = (tls: Parameters<typeof loadServerTls>[0]) => {
      try {
        loadServerTls(tls);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a failure");
    };
    expect(failure({ cert: certs.server.cert, key: "/etc/certs/missing.key" })).toBe("Invalid server.tls.key: cannot read /etc/certs/missing.key");
    expect(failure({ cert: certs.server.cert, key: certs.server.cert })).toBe("Invalid server.tls.key: not a PEM private key");
    expect(failure({ cert: certs.server.key, key: certs.server.key })).toBe("Invalid server.tls.cert: not a PEM certificate");
    expect(failure({ cert: certs.server.cert, key: certs.server2.key })).toBe("Invalid server.tls: the key does not match the certificate");
    for (const message of [failure({ cert: certs.server.certPem, key: certs.server2.keyPem }), failure({ cert: certs.server.certPem, key: certs.server.certPem })]) expect(message).not.toContain("-----BEGIN");
  });
});

describe("serving HTTPS", () => {
  test("the service answers HTTPS with the test CA, refuses plain HTTP, and requests use https", async () => {
    const { base } = await serve(`{ cert: ${JSON.stringify(certs.server.cert)}, key: ${JSON.stringify(certs.server.key)} }`, "production: true,");
    const created = await fetch(`${base}/posts`, { ...trusting, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hi" }) });
    expect(created.status).toBe(201);
    expect(new URL(created.headers.get("location")!, created.url).protocol).toBe("https:");
    expect(created.headers.get("strict-transport-security")).toContain("max-age=");
    expect(((await (await fetch(`${base}/where`, trusting)).json()) as { url: string }).url).toStartWith("https://localhost:");
    expect((await fetch(`${base}/posts`, trusting)).status).toBe(200);
    expect(fetch(base.replace("https:", "http:"))).rejects.toThrow();
  });

  test("inline PEM text serves too, and minVersion TLSv1.3 refuses a TLS 1.2-only client", async () => {
    const { port } = await serve(`{ cert: ${JSON.stringify(certs.server.certPem)}, key: ${JSON.stringify(certs.server.keyPem)}, minVersion: "TLSv1.3" }`);
    expect(await handshake(port, "TLSv1.3")).toBe("ok TLSv1.3");
    expect(await handshake(port, "TLSv1.2")).toStartWith("error");
  });
});

describe("certificate logging and the expiry warning", () => {
  test("startup logs the certificate, and one expiring in 10 days warns unless the window is shorter", async () => {
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => entries.push(entry), warn: (entry: LogEntry) => entries.push(entry), error: (entry: LogEntry) => entries.push(entry) };
    const handlers = new Map<string, () => void>();
    const log = spyOn(console, "log").mockImplementation(() => {});
    let service: RunningService | undefined;
    try {
      service = await startService({
        projectConfig: { database: memoryAdapter(), logger, server: { port: freePort(), tls: { cert: certs.expiring.cert, key: certs.expiring.key } } } as ServiceConfig,
        models: [],
        crudRoutes: [],
        endpoints: [],
        hooks: new Map(),
        env: {},
        process: { once: (signal: string, handler: () => void) => void handlers.set(signal, handler), exit: () => {} } as never,
      });
    } finally {
      log.mockRestore();
    }
    try {
      const info = entries.find((entry) => entry.message === "server.tls")!;
      expect(info).toMatchObject({ subject: expect.stringContaining("CN=localhost"), issuer: expect.stringContaining("Test CA") });
      expect(info.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
      expect(entries.some((entry) => /^server\.tls certificate expires in (9|10) days$/.test(String(entry.message)))).toBe(true);
    } finally {
      await service?.stop();
    }
    const quiet: LogEntry[] = [];
    logServerCertificate({ info: (entry) => quiet.push(entry), warn: (entry) => quiet.push(entry), error() {} }, loadServerTls({ cert: certs.expiring.cert, key: certs.expiring.key }).info, { expiryWarning: "7d" });
    expect(quiet.map((entry) => entry.message)).toEqual(["server.tls"]);
  });
});
