import { cidrMatcher, normalizeAddress } from "../public.ts";

/** The `proxy` item's options. */
export interface ProxyOptions {
  trust: readonly string[];
  header: string;
}

/** The addresses a forwarding header lists, left to right, as written. */
function listed(value: string, header: string): string[] {
  const entries = value.split(",");
  if (header !== "forwarded") return entries;
  // RFC 7239: each element is `key=value` pairs separated by `;`, and the client is its `for` parameter.
  return entries.map((element) => {
    for (const pair of element.split(";")) {
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(0, at).trim().toLowerCase() === "for") return pair.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
    }
    return "";
  });
}

/**
 * The address of the client behind trusted proxies: the right-most address of the header that is not trusted, walking
 * from the right, or the left-most one when every listed address is trusted. An entry that is not an address stops
 * the walk at the last valid address found (or the peer).
 */
export function clientBehindProxies(value: string, header: string, peer: string, trusted: (address: string) => boolean): string {
  const entries = listed(value, header);
  let found = peer;
  for (let index = entries.length - 1; index >= 0; index--) {
    const address = normalizeAddress(entries[index]!);
    if (address === undefined) return found;
    found = address;
    if (!trusted(address)) return address;
  }
  return found;
}

/**
 * The function computing `req.ip` for the `proxy` item: forwarding headers are read only from trusted peers; in
 * production, the first request carrying the header from an untrusted peer calls `untrusted` once.
 */
export function proxyResolver(options: ProxyOptions, untrusted: ((peer: string) => void) | undefined): (request: Request, peer: string) => string {
  const header = options.header.toLowerCase();
  const trusted = cidrMatcher(options.trust);
  let warned = untrusted === undefined;
  return (request, peer) => {
    const value = request.headers.get(header);
    if (value === null) return peer;
    if (!trusted(peer)) {
      if (!warned) {
        warned = true;
        untrusted!(peer);
      }
      return peer;
    }
    return clientBehindProxies(value, header, peer, trusted);
  };
}
