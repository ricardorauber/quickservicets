import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthError, parseDuration, type AuthProvider, type ServiceRequest } from "../public.ts";

/** The headers that carry who a proxied request is for; the gateway always removes the client's own. */
export const IDENTITY_HEADERS = ["x-user-id", "x-user-roles", "x-tenant-id"] as const;

/** The default header of the signed identity. */
export const IDENTITY_HEADER = "x-quickservicets-identity";

/** The text a signature covers: the time, the method, the upstream path and the forwarded user, roles and tenant. */
export function identityPayload(timestamp: number, method: string, path: string, values: { user?: string | null; roles?: string | null; tenant?: string | null }): string {
  return [String(timestamp), method.toUpperCase(), path, values.user ?? "", values.roles ?? "", values.tenant ?? ""].join("\n");
}

/** The value of the identity header: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export function signIdentity(secret: string, timestamp: number, method: string, path: string, values: { user?: string | null; roles?: string | null; tenant?: string | null }): string {
  const signature = createHmac("sha256", secret).update(identityPayload(timestamp, method, path, values)).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/** What `proxyIdentity` takes. */
export interface ProxyIdentityOptions {
  /** The gateway's `proxy.identity.secret`. */
  secret: string;
  /** The header of the signed identity (default `x-quickservicets-identity`). */
  header?: string;
  /** How old a signature may be (default `60s`). */
  maxAge?: string | number;
  /** The provider's name (default `proxy-identity`). */
  name?: string;
}

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * An authentication provider for a QuickService.ts service behind a gateway: for requests carrying the identity header,
 * it verifies the HMAC in constant time and its age, and returns the forwarded user, roles and tenant with the method
 * `apiKey`; a wrong signature or an expired one throws `AuthError` (`invalid-signature` or `expired`).
 */
export function proxyIdentity(options: ProxyIdentityOptions): AuthProvider {
  if (typeof options?.secret !== "string" || options.secret === "") throw new Error("proxyIdentity() needs the gateway's identity secret");
  const header = (options.header ?? IDENTITY_HEADER).toLowerCase();
  const maxAgeMs = typeof options.maxAge === "number" ? options.maxAge : (parseDuration(options.maxAge ?? "60s") ?? 60_000);
  return {
    name: options.name ?? "proxy-identity",
    credentials: { headers: [header] },
    authenticate(req: ServiceRequest) {
      const value = req.headers.get(header);
      if (value === null) return null;
      const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(value.trim());
      if (!match) throw new AuthError("invalid-signature");
      const timestamp = Number(match[1]);
      const values = { user: req.headers.get("x-user-id"), roles: req.headers.get("x-user-roles"), tenant: req.headers.get("x-tenant-id") };
      const expected = signIdentity(options.secret, timestamp, req.method, req.path, values);
      if (!equal(expected, value.trim())) throw new AuthError("invalid-signature");
      if (Math.abs(Date.now() - timestamp * 1000) > maxAgeMs) throw new AuthError("expired");
      if (!values.user) return null;
      const roles = values.roles ? values.roles.split(",").map((role) => role.trim()).filter((role) => role !== "") : [];
      return { user: { id: values.user, roles }, ...(values.tenant ? { tenant: { id: values.tenant } } : {}), method: "apiKey" };
    },
  };
}
