import { cidrMatcher, clientCertificateOf, clientFromEscapedPem, clientFromXfcc, HttpError, peerAddress, safeLog, setClientCertificate, type ClientCertificate, type Logger, type ParsedTag } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { SecurityRoute } from "./routes.ts";

/** Whether a client certificate matches an `allow` entry. */
export type ClientCheck = (client: ClientCertificate) => boolean;

/** The reason an `allow` entry is invalid, or undefined for a valid one. */
export function allowProblem(entry: string): string | undefined {
  if (typeof entry !== "string" || entry.trim() === "") return "expected an entry like CN=billing, dns:*.internal, uri:spiffe://cluster.local/ns/billing/* or sha256:<fingerprint>";
  const field = /^(CN|O|OU)=(.+)$/.exec(entry);
  if (field) return undefined;
  const at = entry.indexOf(":");
  const kind = at > 0 ? entry.slice(0, at) : "";
  const value = entry.slice(at + 1);
  if (kind === "dns" && /^(\*\.)?[a-z0-9.-]+$/i.test(value)) return undefined;
  if (kind === "uri" && value !== "" && !value.slice(0, -1).includes("*")) return undefined;
  if (kind === "email" && value.includes("@")) return undefined;
  if (kind === "sha256" && /^[0-9a-f]{64}$/i.test(value.replaceAll(":", ""))) return undefined;
  return `expected CN=, O=, OU=, dns:, uri:, email: or sha256: with a value, got ${JSON.stringify(entry)}`;
}

/** The problems of an `allow` list, one per invalid entry, as `Invalid <label>[<i>]: <reason>`. */
export function allowProblems(entries: readonly string[], label = "security.mtls.allow"): string[] {
  return entries.flatMap((entry, index) => {
    const problem = allowProblem(entry);
    return problem ? [`Invalid ${label}[${index}]: ${problem}`] : [];
  });
}

/** One allow entry as a check. */
function entryCheck(entry: string): ClientCheck {
  const field = /^(CN|O|OU)=(.+)$/.exec(entry);
  if (field) {
    const [, name, value] = field as unknown as [string, "CN" | "O" | "OU", string];
    const key = name === "CN" ? "commonName" : name === "O" ? "organization" : "organizationalUnit";
    return (client) => client.subject[key] === value;
  }
  const at = entry.indexOf(":");
  const kind = entry.slice(0, at);
  const value = entry.slice(at + 1);
  if (kind === "dns") {
    const wanted = value.toLowerCase();
    // `*.` matches one or more labels.
    if (wanted.startsWith("*.")) return (client) => client.san.dns.some((name) => name.toLowerCase().endsWith(wanted.slice(1)) && name.length > wanted.length - 1);
    return (client) => client.san.dns.some((name) => name.toLowerCase() === wanted);
  }
  if (kind === "uri") {
    if (value.endsWith("*")) return (client) => client.san.uri.some((uri) => uri.startsWith(value.slice(0, -1)));
    return (client) => client.san.uri.includes(value);
  }
  if (kind === "email") return (client) => client.san.email.some((email) => email.toLowerCase() === value.toLowerCase());
  const fingerprint = value.replaceAll(":", "").toLowerCase();
  return (client) => client.fingerprint256 === fingerprint;
}

/** The check of an `allow` list: every certificate passes an empty list, otherwise one entry must match. */
export function allowCheck(entries: readonly string[]): ClientCheck | undefined {
  if (entries.length === 0) return undefined;
  const checks = entries.map(entryCheck);
  return (client) => checks.some((check) => check(client));
}

/** The 401 of a route that needs a client certificate without one. */
export const certificateRequired = () => new HttpError(401, "Client certificate required", { code: "CLIENT_CERTIFICATE_REQUIRED" });

/** The 403 of a client certificate outside the allowlist. */
export const clientNotAllowed = () => new HttpError(403, "Client certificate not allowed", { code: "CLIENT_NOT_ALLOWED" });

/** What the mTLS step needs. */
export interface MtlsSettings {
  allow: readonly string[];
  logger: Logger;
  /** Refuses requests without a client certificate everywhere (in the handshake on the TLS path). */
  required?: boolean;
  production?: boolean;
  /** Reads the identity a trusted proxy forwarded, instead of the service's own handshake. */
  forwarded?: { header: string; format: "xfcc" | "pem"; trust: readonly string[] };
}

/** The 400 of a forwarded certificate header the service cannot read. */
export const invalidForwarded = () => new HttpError(400, "Forwarded client certificate is invalid", { code: "INVALID_CLIENT_CERTIFICATE" });

/**
 * Reads the forwarded client certificate of a request: only from a trusted peer (the header is removed for any other,
 * warning once in production), parsed once and kept as `req.client` with `source: "forwarded"`.
 */
function forwardedReader(settings: NonNullable<MtlsSettings["forwarded"]>, logger: Logger, production: boolean) {
  const trusted = cidrMatcher(settings.trust);
  const parse = settings.format === "pem" ? clientFromEscapedPem : clientFromXfcc;
  let warned = false;
  return (request: Request): void => {
    const value = request.headers.get(settings.header);
    if (value === null) return;
    const peer = peerAddress(request);
    if (!trusted(peer)) {
      request.headers.delete(settings.header);
      if (production && !warned) {
        warned = true;
        safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "security.mtls.forwarded.untrusted", peer, header: settings.header });
      }
      return;
    }
    let client: ClientCertificate;
    try {
      client = parse(value);
    } catch (error) {
      safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "security.mtls.forwarded.invalid", peer, reason: (error as Error)?.message ?? String(error) });
      throw invalidForwarded();
    }
    setClientCertificate(request, client);
  };
}

/** The allow check of a route's `@mtls allow=`, compiled once per route; the global check otherwise. */
function routeCheck(route: SecurityRoute, tag: ParsedTag, global: ClientCheck | undefined): ClientCheck | undefined {
  const own = tag.options.allow as string[] | string | undefined;
  if (own === undefined) return global;
  if (!route.cache.has("mtls")) route.cache.set("mtls", allowCheck(Array.isArray(own) ? own : [own]));
  return route.cache.get("mtls") as ClientCheck | undefined;
}

/**
 * The mTLS step, after the IP lists: routes tagged `@mtls` need a verified client certificate (401 without one), and
 * a certificate outside the applicable allowlist answers 403, logged as `security.mtls.rejected`; `@mtls off` and
 * exempted paths skip the checks.
 */
export function mtlsStep(settings: MtlsSettings): SecurityStep {
  const global = allowCheck(settings.allow);
  const readForwarded = settings.forwarded ? forwardedReader(settings.forwarded, settings.logger, settings.production === true) : undefined;
  return {
    name: "mtls",
    before(state: SecurityState) {
      // The forwarded header is read (or removed) before anything else sees the request, exempt paths included.
      if (readForwarded) {
        try {
          readForwarded(state.ctx.request);
        } catch (error) {
          throw state.refuse("mtls", error as HttpError);
        }
      }
      if (state.exempt & EXEMPT.mtls) return;
      const tag = state.route?.tags.mtls;
      if (tag && !tag.on) return;
      const client = clientCertificateOf(state.ctx.request);
      if (!client) {
        if (tag?.on || settings.required) throw state.refuse("mtls", certificateRequired());
        return;
      }
      const check = tag?.on ? routeCheck(state.route!, tag, global) : global;
      if (check && !check(client)) {
        safeLog(settings.logger, "warn", { timestamp: new Date().toISOString(), message: "security.mtls.rejected", commonName: client.subject.commonName, fingerprint256: client.fingerprint256 });
        throw state.refuse("mtls", clientNotAllowed());
      }
    },
  };
}
