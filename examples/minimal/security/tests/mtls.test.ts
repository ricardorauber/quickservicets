import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { clientCertificateOf, listenWithClientCertificates, type ClientCertificateServer } from "@quickservicets/core";
import { createTestCertificates, type TestCertificate } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
/** Throwaway certificates created for this run in a temporary folder: a test CA, `localhost`, and the clients `billing` and `reports`. */
const certs = createTestCertificates();

/** The example's own files with its config's `security` replaced, plus extra files the test needs. */
function exampleFiles(security: string, extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ["entities", "endpoints", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  const config = readFileSync(join(root, "quickservicets.config.ts"), "utf8");
  files["quickservicets.config.ts"] = config.replace(/security: \{.*\},/, `${security}\n  logger: { info() {}, warn() {}, error() {} },`);
  return { ...files, ...extra };
}

const WHOAMI = {
  "endpoints/whoami/get.ts": 'import type { Endpoint } from "@quickservicets/core";\nconst whoami: Endpoint = (_repos, req) => ({ client: req.client ? { commonName: req.client.subject.commonName, uri: req.client.san.uri, source: req.client.source } : null });\nexport default whoami;\n',
};
const TLS = `server: { tls: { cert: ${JSON.stringify(certs.server.cert)}, key: ${JSON.stringify(certs.server.key)} } },`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function serve(security: string, extra: Record<string, string> = WHOAMI) {
  const service = await startTestService({ files: exampleFiles(security, extra) });
  running.push(service);
  const { port } = await service.listen();
  /** Calls the service over HTTPS, trusting the test CA and presenting `client` when given; a refused handshake is an error. */
  const call = (path: string, client?: TestCertificate, init: RequestInit = {}) =>
    fetch(`https://localhost:${port}${path}`, { ...init, tls: { ca: certs.ca.certPem, ...(client ? { cert: client.certPem, key: client.keyPem } : {}) } } as RequestInit);
  return { service, call };
}

test("the service serves HTTPS, refuses handshakes without a certificate, and sets req.client from the verified one", async () => {
  const { call } = await serve(`${TLS} security: { mtls: { ca: [${JSON.stringify(certs.ca.cert)}] } },`);
  await expect(call("/whoami")).rejects.toThrow();
  const response = await call("/whoami", certs.billing);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ client: { commonName: "billing", uri: ["spiffe://cluster.local/ns/billing/sa/billing"], source: "tls" } });
});

test("the allowlist admits listed identities and answers 403 to other valid certificates", async () => {
  const { call } = await serve(`${TLS} security: { mtls: { ca: [${JSON.stringify(certs.ca.cert)}], allow: ["uri:spiffe://cluster.local/ns/billing/*"] } },`);
  expect((await call("/whoami", certs.billing)).status).toBe(200);
  expect((await call("/whoami", certs.reports)).status).toBe(403);
});

test("in optional mode only @mtls routes need a certificate, and their allow= replaces the global list", async () => {
  const { call } = await serve(`${TLS} security: { mtls: { mode: "optional", ca: [${JSON.stringify(certs.ca.cert)}] } },`);
  expect(await (await call("/whoami")).json()).toEqual({ client: null });
  expect((await call("/internal/sync", undefined, { method: "POST" })).status).toBe(401);
  expect((await call("/internal/sync", certs.reports, { method: "POST" })).status).toBe(403);
  const synced = await call("/internal/sync", certs.billing, { method: "POST" });
  expect(await synced.json()).toEqual({ synced: true, by: "billing" });
});

test("behind a proxy, the XFCC header of a trusted peer sets req.client and another peer's header is dropped", async () => {
  const service = await startTestService({ files: exampleFiles(`security: { proxy: { trust: ["10.0.0.0/8"] }, mtls: { mode: "optional", forwarded: true } },`, WHOAMI) });
  running.push(service);
  const xfcc = `Hash=${"ab".repeat(32)};Subject="CN=billing,O=Acme";URI=spiffe://cluster.local/ns/billing/sa/billing`;
  const trusted = await service.fetch("/whoami", { peer: "10.0.0.2", headers: { "x-forwarded-client-cert": xfcc } });
  expect(await trusted.json()).toEqual({ client: { commonName: "billing", uri: ["spiffe://cluster.local/ns/billing/sa/billing"], source: "forwarded" } });
  const spoofed = await service.fetch("/whoami", { peer: "203.0.113.5", headers: { "x-forwarded-client-cert": xfcc } });
  expect(await spoofed.json()).toEqual({ client: null });
});

let billing: ClientCertificateServer;
beforeAll(() => {
  // An upstream billing service that requires a client certificate and answers with the caller's name.
  billing = listenWithClientCertificates({
    port: 0,
    hostname: "localhost",
    tls: { cert: certs.server.certPem, key: certs.server.keyPem },
    clientCa: [certs.ca.certPem],
    required: true,
    fetch: (request) => Response.json({ caller: clientCertificateOf(request)?.subject.commonName }),
  });
});
afterAll(() => billing.stop(true));

test("a named service presents its client certificate on outgoing calls", async () => {
  const tls = `tls: { cert: ${JSON.stringify(certs.billing.cert)}, key: ${JSON.stringify(certs.billing.key)}, ca: [${JSON.stringify(certs.ca.cert)}] }`;
  const call = {
    "endpoints/billing-check/get.ts": 'import type { Endpoint } from "@quickservicets/core";\nconst check: Endpoint = async (_repos, req) => req.http.service("billing").get("/").send();\nexport default check;\n',
  };
  const service = await startTestService({ files: exampleFiles(`http: { allow: ["loopback"], services: { billing: { url: "https://localhost:${billing.port}", ${tls} } } },`, call) });
  running.push(service);
  expect(await (await service.fetch("/billing-check")).json()).toEqual({ caller: "billing" });
});
