import { X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";

/** The identity of a caller's client certificate, as `req.client` holds it. */
export interface ClientCertificate {
  subject: { commonName?: string; organization?: string; organizationalUnit?: string };
  issuer: { commonName?: string; organization?: string };
  /** The subject alternative names, by kind. */
  san: { dns: string[]; uri: string[]; email: string[]; ip: string[] };
  /** The SHA-256 fingerprint, lowercase hex without separators. */
  fingerprint256: string;
  /** The serial number, lowercase hex; empty when a proxy forwarded only the identity. */
  serialNumber: string;
  /** When the certificate became valid, when the certificate itself is known. */
  validFrom?: Date;
  /** When the certificate expires, when the certificate itself is known. */
  validTo?: Date;
  /** `tls` when the service verified it in the handshake, `forwarded` when a trusted proxy did. */
  source: "tls" | "forwarded";
  /** The certificate in PEM, when it is known. */
  pem?: string;
}

/** The client certificate of each request, or a function computing it on first read. */
const certificates = new WeakMap<Request, ClientCertificate | (() => ClientCertificate | undefined) | undefined>();

/** Sets the client certificate of a request, or a function computing it once on first read. */
export function setClientCertificate(request: Request, value: ClientCertificate | (() => ClientCertificate | undefined)): void {
  certificates.set(request, value);
}

/** The client certificate of a request (`req.client`), computed once; undefined without one. */
export function clientCertificateOf(request: Request): ClientCertificate | undefined {
  const value = certificates.get(request);
  if (typeof value !== "function") return value;
  const computed = value();
  certificates.set(request, computed);
  return computed;
}

/** The values of a name (`CN`, `O`, `OU`) in a distinguished name as `X509Certificate` prints it, one per line. */
function nameField(name: string, field: string): string | undefined {
  for (const line of name.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.slice(0, at).trim() === field) return line.slice(at + 1).trim();
  }
  return undefined;
}

/** The subject alternative names of `DNS:a, URI:b, email:c, IP Address:d`, by kind. */
export function parseAltNames(text: string | undefined): ClientCertificate["san"] {
  const san: ClientCertificate["san"] = { dns: [], uri: [], email: [], ip: [] };
  for (const part of (text ?? "").split(/,\s*/)) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const kind = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (kind === "dns") san.dns.push(value);
    else if (kind === "uri") san.uri.push(value);
    else if (kind === "email") san.email.push(value);
    else if (kind === "ip address") san.ip.push(value);
  }
  return san;
}

const lowerHex = (fingerprint: string) => fingerprint.replaceAll(":", "").toLowerCase();

/** The client identity of a PEM certificate. */
export function clientFromPem(pem: string, source: ClientCertificate["source"]): ClientCertificate {
  const certificate = new X509Certificate(pem);
  const subject = certificate.subject;
  const issuer = certificate.issuer;
  return {
    subject: compact({ commonName: nameField(subject, "CN"), organization: nameField(subject, "O"), organizationalUnit: nameField(subject, "OU") }),
    issuer: compact({ commonName: nameField(issuer, "CN"), organization: nameField(issuer, "O") }),
    san: parseAltNames(certificate.subjectAltName),
    fingerprint256: lowerHex(certificate.fingerprint256),
    serialNumber: certificate.serialNumber.toLowerCase(),
    validFrom: new Date(certificate.validFrom),
    validTo: new Date(certificate.validTo),
    source,
    pem,
  };
}

const compact = <T extends Record<string, string | undefined>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]?: string };

/** The client identity of a peer certificate a TLS socket verified. */
export function clientFromPeer(peer: PeerCertificate): ClientCertificate {
  const raw = (peer as PeerCertificate & { raw?: Uint8Array }).raw;
  if (raw && raw.byteLength > 0) {
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(raw).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
    return clientFromPem(pem, "tls");
  }
  const field = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return {
    subject: compact({ commonName: field(peer.subject?.CN), organization: field(peer.subject?.O), organizationalUnit: field(peer.subject?.OU) }),
    issuer: compact({ commonName: field(peer.issuer?.CN), organization: field(peer.issuer?.O) }),
    san: parseAltNames(peer.subjectaltname),
    fingerprint256: lowerHex(peer.fingerprint256 ?? ""),
    serialNumber: (peer.serialNumber ?? "").toLowerCase(),
    validFrom: new Date(peer.valid_from),
    validTo: new Date(peer.valid_to),
    source: "tls",
  };
}

/** A forwarded header the service cannot read. */
export class InvalidForwardedCertificate extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidForwardedCertificate";
  }
}

/** Splits text on a separator outside double quotes, failing on an unbalanced quote. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quoted) {
      current += char + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (quoted) throw new InvalidForwardedCertificate("an unbalanced quote");
  parts.push(current);
  return parts;
}

/** A value of an XFCC pair: unquoted, with escaped quotes restored. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  return trimmed;
}

/** The fields of a distinguished name written as `CN=billing,OU=Payments,O=Acme`. */
function distinguishedName(text: string): ClientCertificate["subject"] {
  const fields: Record<string, string> = {};
  for (const part of text.split(/(?<!\\),/)) {
    const at = part.indexOf("=");
    if (at > 0) fields[part.slice(0, at).trim().toUpperCase()] ??= part.slice(at + 1).trim().replace(/\\,/g, ",");
  }
  return compact({ commonName: fields.CN, organization: fields.O, organizationalUnit: fields.OU });
}

/**
 * The client of an Envoy `x-forwarded-client-cert` header: comma-separated elements of `key=value` pairs (`By`,
 * `Hash`, `Cert`, `Chain`, `Subject`, `URI`, `DNS`), quoted values and URL-encoded certificates; the right-most element
 * is the one the nearest proxy added. With `Cert`, the client comes from the certificate; otherwise from `Subject`,
 * `URI`, `DNS` and `Hash`. Throws `InvalidForwardedCertificate` for a header it cannot read.
 */
export function clientFromXfcc(header: string): ClientCertificate {
  const elements = splitOutsideQuotes(header, ",").filter((element) => element.trim() !== "");
  const last = elements.at(-1);
  if (last === undefined) throw new InvalidForwardedCertificate("no element");
  const pairs = new Map<string, string[]>();
  for (const pair of splitOutsideQuotes(last, ";")) {
    if (pair.trim() === "") continue;
    const at = pair.indexOf("=");
    if (at <= 0) throw new InvalidForwardedCertificate("a pair without a key");
    const key = pair.slice(0, at).trim().toLowerCase();
    pairs.set(key, [...(pairs.get(key) ?? []), unquote(pair.slice(at + 1))]);
  }
  if (pairs.size === 0) throw new InvalidForwardedCertificate("an empty element");
  const cert = pairs.get("cert")?.[0];
  if (cert !== undefined) return clientFromEscapedPem(cert);
  const hash = pairs.get("hash")?.[0]?.toLowerCase();
  if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) throw new InvalidForwardedCertificate("a hash that is not a SHA-256 fingerprint");
  const subject = pairs.get("subject")?.[0];
  if (subject === undefined && hash === undefined && !pairs.has("uri") && !pairs.has("dns")) throw new InvalidForwardedCertificate("no identity");
  return {
    subject: subject === undefined ? {} : distinguishedName(subject),
    issuer: {},
    san: { dns: pairs.get("dns") ?? [], uri: pairs.get("uri") ?? [], email: [], ip: [] },
    fingerprint256: hash ?? "",
    serialNumber: "",
    source: "forwarded",
  };
}

/** The client of a URL-encoded PEM certificate (NGINX `$ssl_client_escaped_cert`). */
export function clientFromEscapedPem(value: string): ClientCertificate {
  let pem: string;
  try {
    pem = decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    throw new InvalidForwardedCertificate("a certificate that is not URL-encoded");
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new InvalidForwardedCertificate("not a PEM certificate");
  try {
    return clientFromPem(pem, "forwarded");
  } catch {
    throw new InvalidForwardedCertificate("a certificate that cannot be read");
  }
}
