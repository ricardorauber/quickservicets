import { constants, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError } from "./config-error.ts";
import { parseDuration } from "./jobs/job.ts";
import { safeLog, type Logger } from "./logger.ts";

/** The TLS settings of `server.tls`: each of `cert`, `key` and `ca` is a file path or PEM text. */
export interface ServerTlsConfig {
  /** The certificate (chain), as a file path or PEM text. */
  cert: string;
  /** The private key, as a file path or PEM text. */
  key: string;
  /** Certificate authorities, as file paths or PEM text. */
  ca?: string | readonly string[];
  /** The passphrase of an encrypted key. */
  passphrase?: string;
  /** The lowest TLS version accepted (default `TLSv1.2`). */
  minVersion?: "TLSv1.2" | "TLSv1.3";
  /** Logs a warning at startup when the certificate expires within this duration (default `14d`). */
  expiryWarning?: string;
  /** The window the certificate expiry monitoring treats as critical (default `3d`). */
  expiryCritical?: string;
  /** Checks the files for changes and applies renewed certificates without a restart (default true). */
  watch?: boolean;
  /** How often the files are checked (default `1m`). */
  reloadInterval?: string;
}

/** What a log line and an expiry check need of a certificate. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  notAfter: Date;
  /** The SHA-256 fingerprint, lowercase hex without separators. */
  fingerprint256: string;
}

/** The checked PEM texts of `server.tls`, as `Bun.serve` takes them. */
export interface LoadedTls {
  cert: string;
  key: string;
  ca?: string[];
  passphrase?: string;
  minVersion: "TLSv1.2" | "TLSv1.3";
  /** The `secureOptions` that refuse the versions below the minimum. */
  secureOptions: number;
  info: CertificateInfo;
  /** The file paths the values were read from, by key (`cert`, `key`, `ca`). */
  files: { cert?: string; key?: string; ca: string[] };
}

const isPem = (value: string) => value.trimStart().startsWith("-----BEGIN");
const CERTIFICATE = /-----BEGIN CERTIFICATE-----/;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

/** A PEM text, read from a file unless the value is PEM text itself; throws without key material in the message. */
function pemOf(value: string, label: string): { pem: string; file?: string } {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`Invalid ${label}: expected a file path or PEM text`);
  if (isPem(value)) return { pem: value };
  try {
    return { pem: readFileSync(value, "utf8"), file: value };
  } catch {
    throw new ConfigError(`Invalid ${label}: cannot read ${value}`);
  }
}

/**
 * Reads certificates given as file paths or PEM text at `label` (`security.mtls.ca`), checking each is a PEM
 * certificate; returns the PEM texts and the files they came from.
 */
export function readCertificates(values: string | readonly string[], label: string): { pems: string[]; files: string[] } {
  const list = (Array.isArray(values) ? values : [values]) as string[];
  const pems: string[] = [];
  const files: string[] = [];
  list.forEach((value, index) => {
    const name = list.length > 1 ? `${label}[${index}]` : label;
    const read = pemOf(value, name);
    if (!CERTIFICATE.test(read.pem)) throw new ConfigError(`Invalid ${name}: not a PEM certificate`);
    pems.push(read.pem);
    if (read.file) files.push(read.file);
  });
  return { pems, files };
}

/** The SHA-256 fingerprint of a certificate, lowercase hex without separators. */
export const fingerprintOf = (certificate: X509Certificate) => certificate.fingerprint256.replaceAll(":", "").toLowerCase();

/** The subject, issuer, expiry and fingerprint of a PEM certificate. */
export function certificateInfo(pem: string): CertificateInfo {
  const certificate = new X509Certificate(pem);
  return { subject: certificate.subject.replace(/\n/g, ", "), issuer: certificate.issuer.replace(/\n/g, ", "), notAfter: new Date(certificate.validTo), fingerprint256: fingerprintOf(certificate) };
}

/**
 * Reads and checks a TLS certificate and key at `label` (`server.tls`, `http.services.billing.tls`): each value is a
 * file path or PEM text of the expected kind, CAs are certificates, and the key matches the certificate. Messages
 * never hold key material.
 */
export function loadCertificatePair(tls: Pick<ServerTlsConfig, "cert" | "key" | "ca" | "passphrase">, label: string): { cert: string; key: string; ca?: string[]; info: CertificateInfo; files: LoadedTls["files"] } {
  const cert = pemOf(tls.cert, `${label}.cert`);
  if (!CERTIFICATE.test(cert.pem)) throw new ConfigError(`Invalid ${label}.cert: not a PEM certificate`);
  const key = pemOf(tls.key, `${label}.key`);
  if (!PRIVATE_KEY.test(key.pem)) throw new ConfigError(`Invalid ${label}.key: not a PEM private key`);
  const cas = tls.ca === undefined ? [] : (Array.isArray(tls.ca) ? tls.ca : [tls.ca]) as string[];
  const ca = cas.map((value, index) => {
    const read = pemOf(value, cas.length > 1 ? `${label}.ca[${index}]` : `${label}.ca`);
    if (!CERTIFICATE.test(read.pem)) throw new ConfigError(`Invalid ${cas.length > 1 ? `${label}.ca[${index}]` : `${label}.ca`}: not a PEM certificate`);
    return read;
  });
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert.pem);
  } catch {
    throw new ConfigError(`Invalid ${label}.cert: not a PEM certificate`);
  }
  let publicKey: string;
  try {
    const privateKey = createPrivateKey({ key: key.pem, ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}) });
    publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
  } catch {
    throw new ConfigError(`Invalid ${label}.key: cannot read the private key (a wrong passphrase or a damaged key)`);
  }
  if (publicKey !== (certificate.publicKey.export({ type: "spki", format: "pem" }) as string)) throw new ConfigError(`Invalid ${label}: the key does not match the certificate`);
  return {
    cert: cert.pem,
    key: key.pem,
    ...(ca.length > 0 ? { ca: ca.map((entry) => entry.pem) } : {}),
    info: certificateInfo(cert.pem),
    files: { ...(cert.file ? { cert: cert.file } : {}), ...(key.file ? { key: key.file } : {}), ca: ca.flatMap((entry) => (entry.file ? [entry.file] : [])) },
  };
}

/** The `secureOptions` refusing TLS versions below the minimum: 1.0 and 1.1 always, 1.2 too for `TLSv1.3`. */
export function secureOptionsFor(minVersion: "TLSv1.2" | "TLSv1.3"): number {
  const below12 = constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1;
  return minVersion === "TLSv1.3" ? below12 | constants.SSL_OP_NO_TLSv1_2 : below12;
}

const loaded = new WeakMap<object, LoadedTls>();

/** Reads and checks `server.tls` once per config object, failing with `Invalid server.tls.<key>: <reason>`. */
export function loadServerTls(tls: ServerTlsConfig): LoadedTls {
  let result = loaded.get(tls);
  if (result) return result;
  const minVersion = tls.minVersion ?? "TLSv1.2";
  if (minVersion !== "TLSv1.2" && minVersion !== "TLSv1.3") throw new ConfigError(`Invalid server.tls.minVersion: expected "TLSv1.2" or "TLSv1.3"`);
  const pair = loadCertificatePair(tls, "server.tls");
  result = { ...pair, ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}), minVersion, secureOptions: secureOptionsFor(minVersion) };
  loaded.set(tls, result);
  return result;
}

/** The options `Bun.serve` takes for loaded TLS settings. */
export function bunTlsOptions(tls: LoadedTls): Record<string, unknown> {
  return { cert: tls.cert, key: tls.key, ...(tls.ca ? { ca: tls.ca } : {}), ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}), secureOptions: tls.secureOptions };
}

const DAY = 86_400_000;

/**
 * Logs `server.tls` with the certificate's subject, issuer, expiry and fingerprint, and the warning
 * `server.tls certificate expires in <n> days` when fewer days than `expiryWarning` remain.
 */
export function logServerCertificate(logger: Logger, info: CertificateInfo, tls: Pick<ServerTlsConfig, "expiryWarning">, message = "server.tls", now = Date.now()): void {
  safeLog(logger, "info", { timestamp: new Date(now).toISOString(), message, subject: info.subject, issuer: info.issuer, notAfter: info.notAfter.toISOString(), fingerprint256: info.fingerprint256 });
  const warning = parseDuration(tls.expiryWarning ?? "14d") ?? 14 * DAY;
  const left = info.notAfter.getTime() - now;
  if (left < warning) {
    const days = Math.max(0, Math.floor(left / DAY));
    safeLog(logger, "warn", { timestamp: new Date(now).toISOString(), message: `server.tls certificate expires in ${days} days`, notAfter: info.notAfter.toISOString(), fingerprint256: info.fingerprint256 });
  }
}
