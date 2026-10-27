import { cidrMatcher } from "./cidr.ts";
import type { ServiceRequest } from "./hooks.ts";
import { peerAddress } from "./http/server.ts";

/**
 * Decides which origins are allowed: exact origins (scheme, host and port), `*` for any, `https://*.example.com` for
 * one or more subdomain labels with the same scheme, and `null` only when listed.
 */
export class OriginMatcher {
  private readonly any: boolean;
  private readonly exact: Set<string>;
  private readonly patterns: { scheme: string; suffix: string }[];

  constructor(origins: readonly string[]) {
    this.any = origins.includes("*");
    this.exact = new Set(origins.filter((entry) => entry !== "*" && !entry.includes("://*.")).map((entry) => entry.toLowerCase()));
    this.patterns = origins
      .filter((entry) => entry.includes("://*."))
      .map((entry) => {
        const [scheme, rest] = entry.toLowerCase().split("://*.") as [string, string];
        return { scheme: `${scheme}://`, suffix: `.${rest}` };
      });
  }

  allows(origin: string): boolean {
    if (origin === "null") return this.exact.has("null");
    if (this.any) return true;
    const lower = origin.toLowerCase();
    if (this.exact.has(lower)) return true;
    for (const { scheme, suffix } of this.patterns) {
      if (!lower.startsWith(scheme) || !lower.endsWith(suffix)) continue;
      const labels = lower.slice(scheme.length, lower.length - suffix.length);
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(labels)) return true;
    }
    return false;
  }
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

/** `https://api.example.com:443` → `https://api.example.com`, lowercased; undefined for a value that is not an origin. */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin === "null") return undefined;
    const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The service's own origin of a request: its scheme, host and port, with `x-forwarded-proto` and `x-forwarded-host`
 * read only from the trusted proxies of `security.proxy`.
 */
export function ownOriginReader(proxy: { enabled?: boolean; trust?: readonly string[] } | undefined): (req: Pick<ServiceRequest, "headers" | "raw">) => string | undefined {
  const trusted = proxy?.enabled && proxy.trust && proxy.trust.length > 0 ? cidrMatcher(proxy.trust) : undefined;
  return (req) => {
    const url = new URL(req.raw.url);
    let protocol = url.protocol.slice(0, -1);
    let host = req.headers.get("host") ?? url.host;
    if (trusted && trusted(peerAddress(req.raw))) {
      const forwardedProto = req.headers.get("x-forwarded-proto");
      const forwardedHost = req.headers.get("x-forwarded-host");
      if (forwardedProto) protocol = forwardedProto.split(",")[0]!.trim();
      if (forwardedHost) host = forwardedHost.split(",")[0]!.trim();
    }
    return normalizeOrigin(`${protocol}://${host}`);
  };
}

