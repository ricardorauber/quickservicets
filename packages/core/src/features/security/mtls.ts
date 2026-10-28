import { cidrMatcher, clientCertificateOf, OptionError, resolveOption, type FeatureHook, type OptionFunction, type ServiceRequest, clientFromEscapedPem, clientFromXfcc, HttpError, peerAddress, safeLog, setClientCertificate, type ClientCertificate, type Logger, type ParsedTag } from "../public.ts";
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

/** Checks a client certificate beyond its chain, like revocation lists or OCSP; true admits it, a text refuses it. */
export interface ClientCertificateVerifier {
  verify(input: { client: ClientCertificate; certificate: string | undefined }): boolean | string | Promise<boolean | string>;
}

/** What the mTLS step needs. */
export interface MtlsSettings {
  /** The admitted identities, or a function of the request, its client and tenant returning them. */
  allow: readonly string[] | OptionFunction<string[]>;
  /** Runs after verification with the client and the request; may return a changed client or throw to refuse. */
  beforeClient?: readonly FeatureHook<{ client: ClientCertificate; req: ServiceRequest }, undefined>[];
  verifier?: ClientCertificateVerifier;
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
  const fixed = typeof settings.allow === "function" ? undefined : settings.allow;
  const global = fixed ? allowCheck(fixed) : undefined;
  const readForwarded = settings.forwarded ? forwardedReader(settings.forwarded, settings.logger, settings.production === true) : undefined;
  const beforeClient = settings.beforeClient ?? [];
  // A per-request allowlist, client hooks or a verifier need the request's user and tenant: the identity checks then
  // run in the handler stage, after authentication and tenant resolution.
  const late = typeof settings.allow === "function" || beforeClient.length > 0 || settings.verifier !== undefined;
  /** Refuses a certificate, logging it and handing the reason and the client to the refusal hooks. */
  const reject = (state: SecurityState, client: ClientCertificate, reason: string) => {
    safeLog(settings.logger, "warn", { timestamp: new Date().toISOString(), message: "security.mtls.rejected", commonName: client.subject.commonName, fingerprint256: client.fingerprint256, reason });
    return state.refuse("mtls", clientNotAllowed(), { reason, client: { commonName: client.subject.commonName, fingerprint256: client.fingerprint256 } });
  };
  /** Whether the route skips the identity checks: an exempt path, or `@mtls off`. */
  const skipped = (state: SecurityState) => (state.exempt & EXEMPT.mtls) !== 0 || state.route?.tags.mtls?.on === false;
  const step: SecurityStep = {
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
      if (skipped(state)) return;
      const tag = state.route?.tags.mtls;
      const client = clientCertificateOf(state.ctx.request);
      if (!client) {
        if (tag?.on || settings.required) throw state.refuse("mtls", certificateRequired());
        return;
      }
      if (late) return;
      const check = tag?.on ? routeCheck(state.route!, tag, global) : global;
      if (check && !check(client)) throw reject(state, client, "not on the allowlist");
    },
  };
  if (late) {
    step.handler = async (req, state) => {
      if (skipped(state)) return;
      let client = req.client;
      if (!client) return;
      for (const hook of beforeClient) {
        const changed = (await hook({ client, req }, undefined)) as unknown;
        if (changed && typeof changed === "object") client = ("client" in changed ? (changed as { client: ClientCertificate }).client : changed) as ClientCertificate;
      }
      if (client !== req.client) {
        setClientCertificate(req.raw, client);
        Object.defineProperty(req, "client", { value: client, configurable: true, enumerable: true, writable: true });
      }
      if (settings.verifier) {
        const verdict = await settings.verifier.verify({ client, certificate: client.pem });
        if (verdict !== true) throw reject(state, client, typeof verdict === "string" ? verdict : "refused by the verifier");
      }
      const tag = state.route?.tags.mtls;
      let check: ClientCheck | undefined;
      if (tag?.on && tag.options.allow !== undefined) check = routeCheck(state.route!, tag, global);
      else if (typeof settings.allow === "function") {
        const entries = (await resolveOption(settings.allow, { req, client, tenant: req.tenant } as never)) ?? [];
        const problems = allowProblems(entries, "security.mtls.allow");
        if (problems.length > 0) throw new OptionError(problems.join("\n"));
        check = allowCheck(entries);
      } else check = global;
      if (check && !check(client)) throw reject(state, client, "not on the allowlist");
    };
  }
  return step;
}
