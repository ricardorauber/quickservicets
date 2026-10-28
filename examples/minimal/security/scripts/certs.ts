/**
 * Creates throwaway certificates for trying mTLS locally, with openssl, into `certs/` (git-ignored): a local
 * certificate authority, a server certificate for `localhost` and the client certificates `billing` and `reports`.
 * Never use them outside your machine.
 *
 *   bun scripts/certs.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "certs");
const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

function openssl(...args: string[]): void {
  const run = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${run.stderr.toString()}`);
}

/** Creates `<name>.key` and `<name>.crt` signed by the local authority. */
function issue(name: string, subject: string, extensions: string[]): void {
  openssl("req", ...KEY, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subject);
  writeFileSync(join(dir, `${name}.ext`), `${extensions.join("\n")}\n`);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "365", "-extfile", `${name}.ext`);
}

mkdirSync(dir, { recursive: true });
openssl("req", "-x509", ...KEY, "-keyout", "ca.key", "-out", "ca.crt", "-days", "365", "-subj", "/CN=Local Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
issue("server", "/CN=localhost", ["subjectAltName=DNS:localhost,IP:127.0.0.1", "extendedKeyUsage=serverAuth"]);
const client = (san: string) => [`subjectAltName=${san}`, "extendedKeyUsage=clientAuth"];
issue("billing", "/CN=billing/O=Acme", client("URI:spiffe://cluster.local/ns/billing/sa/billing"));
issue("reports", "/CN=reports/O=Acme", client("URI:spiffe://cluster.local/ns/reports/sa/reports"));

console.log(`Wrote ca.crt, server.crt/.key, billing.crt/.key and reports.crt/.key to ${dir}`);
console.log("Serve with: QS_SERVER_TLS_CERT=certs/server.crt QS_SERVER_TLS_KEY=certs/server.key QS_SECURITY_MTLS_ENABLED=true QS_SECURITY_MTLS_CA=certs/ca.crt bun .generated/server.ts");
console.log("Call with:  curl --cacert certs/ca.crt --cert certs/billing.crt --key certs/billing.key https://localhost:3000/internal/sync -X POST");
