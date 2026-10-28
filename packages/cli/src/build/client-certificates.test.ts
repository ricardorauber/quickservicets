import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestCertificates, type TestCertificate } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();

const CONFIG = (security: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).mtlsLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).mtlsLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).mtlsLogs ??= []).push(entry),
  },
  server: { tls: { cert: ${JSON.stringify(certs.server.cert)}, key: ${JSON.stringify(certs.server.key)} } },
  security: { mtls: ${security} },
  ${extra}
});
`;
const logs = () => ((globalThis as { mtlsLogs?: Record<string, unknown>[] }).mtlsLogs ??= []);
const FILES = {
  "entities/Post.ts": "export type Post = { title: string };\n",
  "endpoints/whoami/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ client: req.client ?? null });\n',
  "endpoints/internal/sync/post.ts": "/** @mtls */\nexport default () => ({ synced: true });\n",
  "endpoints/internal/reports/get.ts": "/** @mtls allow=CN=reports */\nexport default () => ({ reports: true });\n",
  "endpoints/boom/get.ts": 'export default () => { throw new Error("boom"); };\n',
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  logs().length = 0;
  delete (globalThis as { reports?: unknown }).reports;
});

async function start(security: string, extra = "", files: Record<string, string> = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(security, extra), ...FILES, ...files } });
  running.push(service);
  const { port } = await service.listen();
  /** Calls the service over HTTPS, presenting `client` when given; resolves the response or the connection error. */
  const call = async (path: string, client?: TestCertificate, init: RequestInit = {}) => {
    try {
      return await fetch(`https://localhost:${port}${path}`, { ...init, tls: { ca: certs.ca.certPem, ...(client ? { cert: client.certPem, key: client.keyPem } : {}) } } as RequestInit);
    } catch (error) {
      return error as Error;
    }
  };
  return { service, call };
}

const json = async (response: Response | Error) => {
  if (response instanceof Error) throw response;
  return (await response.json()) as Record<string, unknown>;
};

describe("options and the server selection", () => {
  test("required mode admits a certificate signed by the CA, with req.client, and refuses the handshake without one", async () => {
    const { call } = await start(`{ ca: [${JSON.stringify(certs.ca.cert)}] }`);
    const answer = await call("/whoami", certs.billing);
    expect(answer instanceof Response && answer.status).toBe(200);
    const client = (await json(answer)).client as Record<string, unknown>;
    expect(client).toMatchObject({ subject: { commonName: "billing", organization: "Acme", organizationalUnit: "Payments" }, issuer: { commonName: "QuickService.ts Test CA" }, source: "tls" });
    expect(client.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    expect(client.san).toMatchObject({ uri: ["spiffe://cluster.local/ns/billing/sa/billing"], dns: ["billing.internal"] });
    expect(await call("/whoami")).toBeInstanceOf(Error);
    expect(await call("/whoami", certs.otherClient)).toBeInstanceOf(Error);
  });

  test("mtls needs server.tls, and refuses to start with ws.ts routes", async () => {
    const noTls = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), security: { mtls: { ca: [${JSON.stringify(certs.ca.cert)}] } } });
`;
    await expect(startTestService({ files: { "quickservicets.config.ts": noTls } })).rejects.toThrow("security.mtls needs server.tls");
    await expect(start(`{ ca: [${JSON.stringify(certs.ca.cert)}] }`, "realtime: {},", { "endpoints/chat/ws.ts": 'import { defineSocket } from "@quickservicets/core";\nexport default defineSocket({ message: () => {} });\n' })).rejects.toThrow(
      "realtime.websockets is not available while the service verifies client certificates itself; terminate mTLS at a proxy and use security.mtls.forwarded",
    );
  });
});

describe("allow patterns", () => {
  test("subject and SPIFFE entries admit their certificates, others get 403, and an invalid entry fails startup", async () => {
    const { call } = await start(`{ ca: [${JSON.stringify(certs.ca.cert)}], allow: ["CN=billing", "uri:spiffe://cluster.local/ns/orders/*"] }`);
    expect((await call("/whoami", certs.billing)) instanceof Response && ((await call("/whoami", certs.billing)) as Response).status).toBe(200);
    expect(((await call("/whoami", certs.orders)) as Response).status).toBe(200);
    const refused = (await call("/whoami", certs.reports)) as Response;
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: unknown }).error).toEqual({ code: "CLIENT_NOT_ALLOWED", message: "Client certificate not allowed" });
    await expect(start(`{ ca: [${JSON.stringify(certs.ca.cert)}], allow: ["XY=1"] }`)).rejects.toThrow("Invalid security.mtls.allow[0]: ");
  });
});

describe("modes and the @mtls tag", () => {
  test("optional mode protects tagged routes only, and a tag's allow replaces the global list", async () => {
    const { call } = await start(`{ mode: "optional", ca: [${JSON.stringify(certs.ca.cert)}] }`);
    const anonymous = (await call("/internal/sync", undefined, { method: "POST" })) as Response;
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: unknown }).error).toEqual({ code: "CLIENT_CERTIFICATE_REQUIRED", message: "Client certificate required" });
    expect(((await call("/posts")) as Response).status).toBe(200);
    expect(((await call("/whoami")) as Response).status).toBe(200);
    expect(((await call("/internal/sync", certs.billing, { method: "POST" })) as Response).status).toBe(200);
    expect(((await call("/internal/reports", certs.reports)) as Response).status).toBe(200);
    expect(((await call("/internal/reports", certs.billing)) as Response).status).toBe(403);
  });
});

describe("exemptions, reports, logs and the disabled path", () => {
  test("health routes skip the allowlist, rejections are logged with the fingerprint, and error reports carry the caller", async () => {
    const head = "";
    const { call } = await start(
      `{ mode: "optional", ca: [${JSON.stringify(certs.ca.cert)}], allow: ["CN=billing"] }`,
      `health: {}, errors: { reporter: { report: (report: any) => void ((globalThis as any).reports ??= []).push(report) }, sampleRate: 1 },${head}`,
    );
    expect(((await call("/health/ready", certs.reports)) as Response).status).toBe(200);
    expect(((await call("/whoami", certs.reports)) as Response).status).toBe(403);
    const rejected = logs().find((entry) => entry.message === "security.mtls.rejected")!;
    expect(rejected).toMatchObject({ commonName: "reports" });
    expect(rejected.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    expect(((await call("/boom", certs.billing)) as Response).status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = ((globalThis as { reports?: { client?: { commonName: string; fingerprint256: string } }[] }).reports ?? [])[0]!;
    expect(report.client?.commonName).toBe("billing");
    expect(report.client?.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    const entries = logs().filter((entry) => typeof entry.status === "number");
    expect(entries.some((entry) => entry.client === "reports")).toBe(true);
  });

  test("without mtls the service listens with Bun.serve", async () => {
    const serve = spyOn(Bun, "serve");
    try {
      const service = await startTestService({ files: { "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} } });\n` } });
      running.push(service);
      await service.listen();
      expect(serve).toHaveBeenCalledTimes(1);
    } finally {
      serve.mockRestore();
    }
  });
});
