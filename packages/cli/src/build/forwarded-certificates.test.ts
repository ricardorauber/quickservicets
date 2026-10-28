import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clientFromXfcc } from "@quickservicets/core";
import { createTestCertificates } from "@quickservicets/core/testing";
import * as certificates from "../../../core/src/client-certificates.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();
const HASH = "ab12".padEnd(64, "0");
const XFCC = `By=spiffe://cluster.local/ns/api/sa/api;Hash=${HASH};Subject="CN=billing";URI=spiffe://cluster.local/ns/billing/sa/billing`;

const CONFIG = (mtls: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  production: ${extra.includes("production") ? "true" : "false"},
  logger: {
    info: (entry: object) => void ((globalThis as any).xfccLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).xfccLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).xfccLogs ??= []).push(entry),
  },
  security: { proxy: { trust: ["10.0.0.0/8"] }, mtls: ${mtls} },
});
`;
const logs = () => ((globalThis as { xfccLogs?: Record<string, unknown>[] }).xfccLogs ??= []);
const FILES = {
  "endpoints/whoami/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ client: req.client ?? null, header: req.headers.get("x-forwarded-client-cert") });\n',
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  logs().length = 0;
});

async function start(mtls: string, extra = "") {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(mtls, extra), ...FILES } });
  running.push(service);
  return service;
}
const whoami = async (service: TestService, peer: string, header?: string) => {
  const response = await service.fetch("/whoami", { peer, ...(header !== undefined ? { headers: { "x-forwarded-client-cert": header } } : {}) });
  return { status: response.status, body: (await response.json()) as { client: Record<string, unknown> | null; header: string | null; error?: { code: string; message: string } } };
};

describe("trusted and untrusted peers", () => {
  test("a trusted proxy's header fills req.client; from another peer it is removed and production warns once", async () => {
    const service = await start(`{ mode: "optional", forwarded: true }`, "production");
    const trusted = await whoami(service, "10.0.0.2", XFCC);
    expect(trusted.status).toBe(200);
    expect(trusted.body.client).toMatchObject({ subject: { commonName: "billing" }, source: "forwarded", fingerprint256: HASH, san: { uri: ["spiffe://cluster.local/ns/billing/sa/billing"] } });
    for (let i = 0; i < 2; i++) {
      const untrusted = await whoami(service, "203.0.113.5", XFCC);
      expect(untrusted.body).toEqual({ client: null, header: null });
    }
    expect(logs().filter((entry) => entry.message === "security.mtls.forwarded.untrusted")).toEqual([expect.objectContaining({ peer: "203.0.113.5" })]);
  });
});

describe("XFCC parsing", () => {
  test("the right-most element wins, quoted values are read, and a URL-encoded Cert gives the certificate's identity with its SANs", () => {
    const two = `Hash=${"cd".repeat(32)};Subject="CN=reports,O=Acme";URI=spiffe://cluster.local/ns/reports/sa/x,${XFCC}`;
    expect(clientFromXfcc(two)).toMatchObject({ subject: { commonName: "billing" }, fingerprint256: HASH });
    expect(clientFromXfcc(`Subject="CN=a\\"b,OU=Team,O=Acme"`).subject).toEqual({ commonName: 'a"b', organizationalUnit: "Team", organization: "Acme" });
    const withCert = `By=spiffe://x;Cert="${encodeURIComponent(certs.orders.certPem)}"`;
    const client = clientFromXfcc(withCert);
    expect(client.subject.commonName).toBe("orders-api");
    expect(client.san.uri).toEqual(["spiffe://cluster.local/ns/orders/sa/api"]);
    expect(client.serialNumber).not.toBe("");
    expect(client.source).toBe("forwarded");
  });
});

describe("PEM headers", () => {
  test("format pem reads an escaped certificate", async () => {
    const service = await start(`{ forwarded: { format: "pem", header: "x-ssl-client-cert" } }`);
    const response = await service.fetch("/whoami", { peer: "10.1.1.1", headers: { "x-ssl-client-cert": encodeURIComponent(certs.billing.certPem) } });
    const body = (await response.json()) as { client: { subject: { commonName: string }; source: string; san: { dns: string[] } } };
    expect(body.client.subject.commonName).toBe("billing");
    expect(body.client.source).toBe("forwarded");
    expect(body.client.san.dns).toEqual(["billing.internal"]);
  });
});

describe("allowlist and answers on forwarded identities", () => {
  test("a SPIFFE allowlist admits its namespace, refuses another, required mode answers 401 without the header, and server.tls is not needed", async () => {
    const service = await start(`{ forwarded: true, allow: ["uri:spiffe://cluster.local/ns/billing/*"] }`);
    expect((await whoami(service, "10.0.0.2", XFCC)).status).toBe(200);
    const other = await whoami(service, "10.0.0.2", XFCC.replace("ns/billing", "ns/orders"));
    expect(other.status).toBe(403);
    expect(other.body.error).toEqual({ code: "CLIENT_NOT_ALLOWED", message: "Client certificate not allowed" });
    const missing = await whoami(service, "10.0.0.2");
    expect(missing.status).toBe(401);
    expect(missing.body.error).toEqual({ code: "CLIENT_CERTIFICATE_REQUIRED", message: "Client certificate required" });
  });
});

describe("invalid headers and cost", () => {
  test("an unreadable header from a trusted peer answers 400 without logging it; requests without it cost one lookup and one parse serves two reads", async () => {
    const service = await start(`{ mode: "optional", forwarded: true }`);
    const invalid = await whoami(service, "10.0.0.2", 'garbage"');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toEqual({ code: "INVALID_CLIENT_CERTIFICATE", message: "Forwarded client certificate is invalid" });
    expect(logs().find((entry) => entry.message === "security.mtls.forwarded.invalid")).toBeDefined();
    expect(JSON.stringify(logs())).not.toContain("garbage");

    const parse = spyOn(certificates, "clientFromXfcc");
    try {
      await service.fetch("/whoami", { peer: "10.0.0.2" });
      expect(parse).not.toHaveBeenCalled();
      const twice = await startTestService({
        files: {
          "quickservicets.config.ts": CONFIG(`{ mode: "optional", forwarded: true }`),
          "endpoints/twice/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ a: req.client?.subject.commonName, b: req.client?.fingerprint256 });\n',
        },
      });
      running.push(twice);
      parse.mockClear();
      expect(await (await twice.fetch("/twice", { peer: "10.0.0.2", headers: { "x-forwarded-client-cert": XFCC } })).json()).toEqual({ a: "billing", b: HASH });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });
});
