import { cidrMatcher, HttpError, peerAddress, type ServiceRequest } from "../public.ts";

/** The sources a tenant id can come from, tried in the order `tenancy.from` lists them. */
export const TENANT_SOURCES = ["header", "subdomain", "path", "auth", "function"] as const;
export type TenantSource = (typeof TENANT_SOURCES)[number];

/** Tenant ids: lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters. */
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const invalidTenant = () => new HttpError(400, "Invalid tenant id", { code: "INVALID_TENANT" });
export const tenantRequired = () => new HttpError(400, "Tenant is required", { code: "TENANT_REQUIRED" });
export const tenantMismatch = () => new HttpError(403, "Tenant does not match the credentials", { code: "TENANT_MISMATCH" });

/** The paths exempted from tenant resolution: exact paths, and prefixes written as a path ending in `/*`. */
export class TenantExemptions {
  private readonly exact = new Set<string>();
  private readonly prefixes: string[] = [];
  private closed = false;

  add(pattern: string): void {
    if (this.closed) throw new Error("tenancy exempt() is only available during setup");
    if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error(`Invalid tenancy exemption ${JSON.stringify(pattern)}: expected a path like /signup or /public/*`);
    if (pattern.endsWith("/*")) this.prefixes.push(pattern.slice(0, -1));
    else this.exact.add(pattern);
  }

  close(): void {
    this.closed = true;
  }

  has(path: string): boolean {
    if (this.exact.has(path)) return true;
    for (const prefix of this.prefixes) if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
    return false;
  }
}

/**
 * The prefix pattern of the `path` source, like `/t/[tenant]`: its literal segments and the position of `[tenant]`.
 * Throws when the pattern has no `[tenant]` segment.
 */
export function compilePathPattern(pattern: string): { segments: string[]; index: number } {
  const segments = pattern.split("/").filter((segment) => segment !== "");
  const index = segments.indexOf("[tenant]");
  if (!pattern.startsWith("/") || index === -1) throw new Error(`tenancy.path must be a path with a [tenant] segment, like /t/[tenant]`);
  return { segments, index };
}

/** The tenant segment and the rest of `pathname` when it starts with the prefix pattern, or undefined. */
export function matchPathPrefix(pattern: { segments: string[]; index: number }, pathname: string): { tenant: string; rest: string } | undefined {
  const parts = pathname.split("/");
  // parts[0] is the empty text before the leading slash.
  if (parts.length < pattern.segments.length + 1) return undefined;
  for (let position = 0; position < pattern.segments.length; position++) {
    const expected = pattern.segments[position]!;
    const actual = parts[position + 1]!;
    if (position === pattern.index) {
      if (actual === "") return undefined;
      continue;
    }
    if (actual !== expected) return undefined;
  }
  const rest = `/${parts.slice(pattern.segments.length + 1).join("/")}`;
  return { tenant: parts[pattern.index + 1]!, rest };
}

/** The single label in front of `domain` in a host (port ignored), or undefined. */
export function subdomainOf(host: string | null, domain: string): string | undefined {
  if (!host) return undefined;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  const base = domain.toLowerCase().replace(/^\./, "");
  if (!name.endsWith(`.${base}`)) return undefined;
  const label = name.slice(0, -(base.length + 1));
  return label !== "" && !label.includes(".") ? label : undefined;
}

/** Reads the host of a request: `x-forwarded-host` from trusted proxies only, else the `host` header. */
export function hostReader(proxy: { enabled?: boolean; trust?: readonly string[]; } | undefined): (req: ServiceRequest) => string | null {
  const trusted = proxy?.enabled && proxy.trust && proxy.trust.length > 0 ? cidrMatcher(proxy.trust) : undefined;
  return (req) => {
    if (trusted) {
      const forwarded = req.headers.get("x-forwarded-host");
      if (forwarded !== null && trusted(peerAddress(req.raw))) return forwarded.split(",")[0]!.trim();
    }
    return req.headers.get("host") ?? new URL(req.raw.url).host;
  };
}
