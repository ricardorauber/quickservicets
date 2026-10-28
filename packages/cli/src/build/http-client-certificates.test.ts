import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientCertificateOf, listenWithClientCertificates, type ClientCertificateServer } from "@quickservicets/core";
import { createTestCertificates } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();
const seen: { server: string; path: string; client: string | null }[] = [];
let secured: ClientCertificateServer;
let elsewhere: ClientCertificateServer;

/** An HTTPS server asking for client certificates, recording who called; `required` refuses calls without one. */
const server = (name: string, required: boolean, answer: (request: Request) => Response) =>
  listenWithClientCertificates({
    port: 0,
    tls: { cert: certs.server.certPem, key: certs.server.keyPem },
    clientCa: [certs.ca.certPem],
    required,
    fetch: async (request) => {
      seen.push({ server: name, path: new URL(request.url).pathname, client: clientCertificateOf(request)?.subject.commonName ?? null });
      return answer(request);
    },
  });

beforeAll(() => {
  elsewhere = server("elsewhere", false, () => Response.json({ elsewhere: true }));
  secured = server("billing", true, (request) =>
    new URL(request.url).pathname === "/away" ? new Response(null, { status: 302, headers: { location: `https://127.0.0.1:${elsewhere.port}/landed` } }) : Response.json({ ok: true, client: clientCertificateOf(request)?.subject.commonName }),
  );
});
afterAll(async () => {
  await secured.stop(true);
  await elsewhere.stop(true);
});

const CONFIG = (billing: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).mtlsClientLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).mtlsClientLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).mtlsClientLogs ??= []).push(entry),
  },
  http: { allow: ["loopback"], tlsReloadInterval: "100ms", services: { billing: { url: "https://localhost:${secured.port}", ${billing} } } },
  ${extra}
});
`;
const logs = () => ((globalThis as { mtlsClientLogs?: Record<string, unknown>[] }).mtlsClientLogs ??= []);
const CALL = `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default async (_repos: Repositories, req: ServiceRequest) => {
  try {
    return { answer: await req.http.service("billing").get(req.query.get("path") ?? "/x").send() };
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
};
`;
const tlsOf = (cert = certs.billing) => `tls: { cert: ${JSON.stringify(cert.cert)}, key: ${JSON.stringify(cert.key)}, ca: [${JSON.stringify(certs.ca.cert)}] }`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  seen.length = 0;
  logs().length = 0;
});

async function start(billing: string, extra = "", env: Record<string, string> = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(billing, extra), "endpoints/call/get.ts": CALL }, env });
  running.push(service);
  return service;
}
const call = async (service: TestService, path = "/x") => (await (await service.fetch(`/call?path=${encodeURIComponent(path)}`)).json()) as { answer?: { ok: boolean; client: string }; code?: string; message?: string };

describe("option shape and validation", () => {
  test("cert without key fails, and an unreadable key fails without PEM text", async () => {
    await expect(start(`tls: { cert: ${JSON.stringify(certs.billing.cert)} }`)).rejects.toThrow("Invalid http.services.billing.tls: cert and key go together");
    const failure = await start(`tls: { cert: ${JSON.stringify(certs.billing.cert)}, key: "/missing/client.key" }`).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain("Invalid http.services.billing.tls.key: cannot read /missing/client.key");
    expect(failure).not.toContain("BEGIN");
  });
});

describe("passing TLS options", () => {
  test("a service with tls presents its certificate, without tls the call fails with TLS, and a redirect elsewhere gets no certificate", async () => {
    const service = await start(tlsOf());
    expect(await call(service)).toEqual({ answer: { ok: true, client: "billing" } });
    const away = await call(service, "/away");
    expect(away.answer).toEqual({ elsewhere: true } as never);
    expect(seen.find((entry) => entry.server === "elsewhere")).toEqual({ server: "elsewhere", path: "/landed", client: null });
    await service.stop();
    running.length = 0;

    logs().length = 0;
    const without = await start("retry: { backoff: \"1ms\" }");
    const failed = await call(without);
    expect(failed.code).toBe("TLS");
    expect(failed.message).toStartWith(`GET https://localhost:${secured.port}/x failed TLS: `);
    // A handshake failure is not transient: the retrying service made one attempt.
    expect(logs().filter((entry) => entry.message === "http.call" && entry.error === "TLS")).toHaveLength(1);
  });
});

describe("production and development rules", () => {
  test("rejectUnauthorized false fails in production and warns in development", async () => {
    await expect(start(`tls: { rejectUnauthorized: false }`, "production: true,")).rejects.toThrow("http.services.billing.tls.rejectUnauthorized cannot be false in production");
    await start(`tls: { rejectUnauthorized: false }`);
    expect(logs().find((entry) => entry.message === "http.tls.insecure")).toMatchObject({ service: "billing" });
  });
});

describe("reloading", () => {
  test("replaced certificate files are presented on the next calls after the interval, logging http.tls.reloaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-client-tls-"));
    copyFileSync(certs.billing.cert, join(dir, "client.crt"));
    copyFileSync(certs.billing.key, join(dir, "client.key"));
    const service = await start(`tls: { cert: ${JSON.stringify(join(dir, "client.crt"))}, key: ${JSON.stringify(join(dir, "client.key"))}, ca: [${JSON.stringify(certs.ca.cert)}] }`);
    expect((await call(service)).answer?.client).toBe("billing");
    copyFileSync(certs.reports.cert, join(dir, "client.crt"));
    copyFileSync(certs.reports.key, join(dir, "client.key"));
    for (let tries = 0; tries < 100 && !logs().some((entry) => entry.message === "http.tls.reloaded"); tries++) await Bun.sleep(20);
    expect(logs().find((entry) => entry.message === "http.tls.reloaded")).toMatchObject({ service: "billing" });
    expect((await call(service)).answer?.client).toBe("reports");
  });
});

describe("variables and the proxy", () => {
  test("a proxy route on the service presents the certificate, and QS_HTTP_SERVICES_BILLING_TLS_CERT points to another file", async () => {
    const service = await start(tlsOf(), `proxy: { routes: { billing: { path: "/billing/*", service: "billing", stripPrefix: true } } },`, {
      QS_HTTP_SERVICES_BILLING_TLS_CERT: certs.reports.cert,
      QS_HTTP_SERVICES_BILLING_TLS_KEY: certs.reports.key,
    });
    const proxied = await service.fetch("/billing/x");
    expect(await proxied.json()).toEqual({ ok: true, client: "reports" });
    expect((await call(service)).answer?.client).toBe("reports");
  });
});
