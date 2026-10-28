import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { createTestCertificates, type TestCertificate } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();
const CA = JSON.stringify(certs.ca.cert);
const TLS = `server: { tls: { cert: ${JSON.stringify(certs.server.cert)}, key: ${JSON.stringify(certs.server.key)} } },`;

const CONFIG = (body: string, head = "") => `import { certificateAuth, defineConfig, HttpError, memoryAdapter } from "@quickservicets/core";
${head}
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${body}
});
`;
const FILES = {
  "endpoints/whoami/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ client: req.client?.subject.commonName ?? null, user: req.user?.id ?? null });\n',
};
const SYNC = { "endpoints/internal/sync/post.ts": "/** @roles service */\nexport default () => ({ synced: true });\n" };

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  delete (globalThis as { rejections?: unknown }).rejections;
});

async function start(body: string, options: { head?: string; env?: Record<string, string>; files?: Record<string, string> } = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(body, options.head), ...FILES, ...options.files }, ...(options.env ? { env: options.env } : {}) });
  running.push(service);
  const { port } = await service.listen();
  const call = async (path: string, client?: TestCertificate, init: RequestInit = {}) => {
    try {
      return await fetch(`https://localhost:${port}${path}`, { ...init, tls: { ca: certs.ca.certPem, ...(client ? { cert: client.certPem, key: client.keyPem } : {}) } } as RequestInit);
    } catch (error) {
      return error as Error;
    }
  };
  return { service, call };
}
const status = async (response: Response | Error) => (response instanceof Error ? "refused" : response.status);

describe("variables", () => {
  test("QS_SECURITY_MTLS_* and QS_SERVER_TLS_* turn mTLS on without config, and QS_SECURITY_MTLS_ALLOW restricts it", async () => {
    const env = { QS_SERVER_TLS_CERT: certs.server.cert, QS_SERVER_TLS_KEY: certs.server.key, QS_SECURITY_MTLS_ENABLED: "true", QS_SECURITY_MTLS_CA: certs.ca.cert, QS_SECURITY_MTLS_ALLOW: "CN=billing" };
    const { call } = await start("", { env });
    expect(await status(await call("/whoami"))).toBe("refused");
    expect(await status(await call("/whoami", certs.billing))).toBe(200);
    expect(await status(await call("/whoami", certs.reports))).toBe(403);
  });
});

describe("per-request allowlists", () => {
  test("each tenant lists the client identities it accepts", async () => {
    const { call } = await start(
      `${TLS} tenancy: { source: "config", tenants: { acme: { attributes: { clients: "CN=billing" } }, globex: { attributes: { clients: "CN=reports" } } } },
  security: { mtls: { ca: [${CA}], allow: ({ tenant }) => tenant?.attributes.clients?.split(",") ?? [] } },`,
    );
    expect(await status(await call("/whoami", certs.billing, { headers: { "x-tenant-id": "acme" } }))).toBe(200);
    expect(await status(await call("/whoami", certs.billing, { headers: { "x-tenant-id": "globex" } }))).toBe(403);
  });
});

describe("hooks and certificateAuth", () => {
  test("beforeClient refuses with its error, onRejected gets the reason and fingerprint, and certificateAuth makes service users", async () => {
    const { call } = await start(
      `${TLS} auth: { providers: [certificateAuth({ user: (c) => (c.subject.commonName === "billing" ? { id: c.subject.commonName, roles: ["service"] } : null) })] },
  security: { mtls: {
    mode: "optional",
    ca: [${CA}],
    allow: ["CN=billing", "CN=orders-api"],
    beforeClient: [({ client }) => { if (client.validTo!.getTime() - Date.now() < 86_400_000) throw new HttpError(403, "Certificate expires too soon"); }],
    onRejected: [({ reason, client }) => void ((globalThis as any).rejections ??= []).push({ reason, client })],
  } },`,
      { files: SYNC },
    );
    expect(await status(await call("/whoami", certs.orders))).toBe(200);
    const refused = await call("/whoami", certs.shortLived);
    expect(await status(refused)).toBe(403);
    expect(((await (refused as Response).json()) as { error: { message: string } }).error.message).toBe("Certificate expires too soon");
    expect(await status(await call("/whoami", certs.reports))).toBe(403);
    const rejections = (globalThis as { rejections?: { reason: string; client: { commonName: string; fingerprint256: string } }[] }).rejections ?? [];
    expect(rejections.at(-1)).toMatchObject({ reason: "not on the allowlist", client: { commonName: "reports" } });
    expect(rejections.at(-1)!.client.fingerprint256).toMatch(/^[0-9a-f]{64}$/);

    expect(await (await call("/whoami", certs.billing) as Response).json()).toEqual({ client: "billing", user: "billing" });
    expect(await status(await call("/internal/sync", certs.billing, { method: "POST" }))).toBe(200);
    expect(await status(await call("/internal/sync", undefined, { method: "POST" }))).toBe(401);
  });
});

describe("the verifier", () => {
  test("a verifier refusing a serial number answers 403, and one without verify fails startup", async () => {
    const serial = new X509Certificate(certs.reports.certPem).serialNumber.toLowerCase();
    const head = `const revoked = new Set([${JSON.stringify(serial)}]);
const verifier = { verify: ({ client }: { client: { serialNumber: string } }) => (revoked.has(client.serialNumber) ? "revoked" : true) };`;
    const { call } = await start(`${TLS} security: { mtls: { ca: [${CA}], verifier } },`, { head });
    expect(await status(await call("/whoami", certs.billing))).toBe(200);
    expect(await status(await call("/whoami", certs.reports))).toBe(403);
    await expect(startTestService({ files: { "quickservicets.config.ts": CONFIG(`${TLS} security: { mtls: { ca: [${CA}], verifier: { check() {} } } },`) } })).rejects.toThrow("Invalid security.mtls.verifier: ");
  });
});
