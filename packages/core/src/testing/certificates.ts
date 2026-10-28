import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A certificate and its private key, as file paths and PEM text. */
export interface TestCertificate {
  cert: string;
  key: string;
  certPem: string;
  keyPem: string;
}

/** The throwaway certificates of a test run, created in a temporary folder; never use them outside tests. */
export interface TestCertificates {
  /** The folder holding every file. */
  dir: string;
  /** The test certificate authority, which signs every certificate below except `otherClient`. */
  ca: { cert: string; key: string; certPem: string };
  /** Another authority, which signs nothing the services trust. */
  otherCa: { cert: string; key: string; certPem: string };
  /** `CN=localhost` with the SANs `localhost` and `127.0.0.1`, valid for ten years. */
  server: TestCertificate;
  /** A second server pair with the same names, for reload tests. */
  server2: TestCertificate;
  /** A server pair that expires in ten days. */
  expiring: TestCertificate;
  /** Client `CN=billing, O=Acme, OU=Payments`, with the SAN `spiffe://cluster.local/ns/billing/sa/billing`. */
  billing: TestCertificate;
  /** Client `CN=reports, O=Acme`. */
  reports: TestCertificate;
  /** Client `CN=orders-api`, with the SAN `spiffe://cluster.local/ns/orders/sa/api`. */
  orders: TestCertificate;
  /** Client `CN=orders-api` that expires in one day. */
  shortLived: TestCertificate;
  /** Client `CN=billing` signed by `otherCa`. */
  otherClient: TestCertificate;
}

/** Runs openssl, failing with its output. */
function openssl(args: string[], cwd: string): void {
  const run = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${run.stderr.toString()}`);
}

const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

/** Creates a key and a certificate signed by `ca`, with the given subject, SANs, usage and validity. */
function issue(dir: string, name: string, ca: string, subject: string, extensions: string[], days: number): TestCertificate {
  openssl(["req", ...KEY, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subject], dir);
  writeFileSync(join(dir, `${name}.ext`), `${extensions.join("\n")}\n`);
  openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-days", String(days), "-extfile", `${name}.ext`], dir);
  return { cert: join(dir, `${name}.crt`), key: join(dir, `${name}.key`), certPem: readFileSync(join(dir, `${name}.crt`), "utf8"), keyPem: readFileSync(join(dir, `${name}.key`), "utf8") };
}

/** Creates a self-signed authority. */
function authority(dir: string, name: string, subject: string) {
  openssl(["req", "-x509", ...KEY, "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "3650", "-subj", subject, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], dir);
  return { cert: join(dir, `${name}.crt`), key: join(dir, `${name}.key`), certPem: readFileSync(join(dir, `${name}.crt`), "utf8") };
}

let created: TestCertificates | undefined;

/**
 * Creates (once per process) a test certificate authority, server certificates for `localhost` and client
 * certificates in a temporary folder with `openssl`, so tests serve HTTPS and mutual TLS without committed keys.
 */
export function createTestCertificates(): TestCertificates {
  if (created) return created;
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-test-certs-"));
  const ca = authority(dir, "ca", "/CN=QuickService.ts Test CA/O=QuickService.ts Tests");
  const otherCa = authority(dir, "other-ca", "/CN=Other Test CA/O=Elsewhere");
  const server = ["subjectAltName=DNS:localhost,IP:127.0.0.1", "extendedKeyUsage=serverAuth", "keyUsage=critical,digitalSignature"];
  const client = (san?: string) => [...(san ? [`subjectAltName=${san}`] : []), "extendedKeyUsage=clientAuth", "keyUsage=critical,digitalSignature"];
  created = {
    dir,
    ca,
    otherCa,
    server: issue(dir, "server", "ca", "/CN=localhost/O=QuickService.ts Tests", server, 3650),
    server2: issue(dir, "server2", "ca", "/CN=localhost/O=QuickService.ts Tests 2", server, 3650),
    expiring: issue(dir, "expiring", "ca", "/CN=localhost/O=Expiring", server, 10),
    billing: issue(dir, "client-billing", "ca", "/CN=billing/O=Acme/OU=Payments", client("URI:spiffe://cluster.local/ns/billing/sa/billing,DNS:billing.internal"), 3650),
    reports: issue(dir, "client-reports", "ca", "/CN=reports/O=Acme", client(), 3650),
    orders: issue(dir, "client-orders", "ca", "/CN=orders-api/O=Acme", client("URI:spiffe://cluster.local/ns/orders/sa/api"), 3650),
    shortLived: issue(dir, "client-short-lived", "ca", "/CN=orders-api/O=Acme", client(), 1),
    otherClient: issue(dir, "client-other", "other-ca", "/CN=billing/O=Acme", client(), 3650),
  };
  return created;
}
