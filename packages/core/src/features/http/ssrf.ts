import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { cidrMatcher, matchesCidr } from "../public.ts";
import { sharedState } from "./state.ts";

/** The address blocks a call may not reach while SSRF protection is on, with what each is. */
const BLOCKED: readonly (readonly [string, string])[] = [
  ["0.0.0.0/8", "an unspecified address"],
  ["127.0.0.0/8", "a loopback address"],
  ["::1/128", "a loopback address"],
  ["::/128", "an unspecified address"],
  ["10.0.0.0/8", "a private address"],
  ["172.16.0.0/12", "a private address"],
  ["192.168.0.0/16", "a private address"],
  ["100.64.0.0/10", "a shared address"],
  ["169.254.0.0/16", "a link-local address"],
  ["fe80::/10", "a link-local address"],
  ["fc00::/7", "a unique local address"],
  ["255.255.255.255/32", "a broadcast address"],
  ["192.0.0.0/24", "a reserved address"],
  ["198.18.0.0/15", "a reserved address"],
  ["240.0.0.0/4", "a reserved address"],
  ["224.0.0.0/4", "a multicast address"],
  ["ff00::/8", "a multicast address"],
];

/** The NAT64 block, whose addresses embed an IPv4 address in their last 32 bits; IPv4-mapped addresses read as IPv4. */
const NAT64 = "64:ff9b::/96";

/** Host names blocked before resolution. */
const RESERVED_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/** The category of a reserved host name. */
export const RESERVED_NAME = "a reserved name";

/** The 32 bits after the first 96 of an IPv6 address, as dotted IPv4. */
function embeddedIpv4(address: string): string | undefined {
  const text = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) return dotted[1];
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail].map((group) => Number.parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  const [high, low] = [groups[6]!, groups[7]!];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * What a blocked address is, like `a loopback address`, or undefined when a call may reach it; IPv6 forms that embed an
 * IPv4 address are judged by the embedded address.
 */
export function blockedCategory(address: string): string | undefined {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return undefined;
  if (family === 6 && matchesCidr(bare, NAT64)) {
    const embedded = embeddedIpv4(bare);
    return embedded === undefined ? undefined : blockedCategory(embedded);
  }
  for (const [block, category] of BLOCKED) if (matchesCidr(bare, block)) return category;
  return undefined;
}

/** Whether a host name is blocked before resolution: `localhost`, `*.localhost` and cloud metadata names. */
export function isReservedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return RESERVED_NAMES.has(name) || name.endsWith(".localhost");
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** Whether an `allow` item is a host name pattern like `billing.internal` or `*.internal`. */
export function isHostPattern(item: string): boolean {
  return HOST_PATTERN.test(item);
}

/** A compiled `allow` list: host name patterns match URL hosts, blocks match resolved addresses. */
export interface AllowList {
  host(host: string): boolean;
  address(address: string): boolean;
}

/** Compiles `allow` items, each an address, a CIDR block, `loopback`, `private`, `linklocal` or a host name pattern. */
export function allowList(items: readonly string[]): AllowList {
  const blocks: string[] = [];
  const hosts: string[] = [];
  for (const item of items) {
    if (isCidrItem(item)) blocks.push(item);
    else hosts.push(item.toLowerCase());
  }
  const inBlocks = blocks.length > 0 ? cidrMatcher(blocks) : () => false;
  return {
    host(host) {
      const name = host.toLowerCase().replace(/\.$/, "");
      return hosts.some((pattern) => (pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern));
    },
    address: (address) => inBlocks(address.replace(/^\[|\]$/g, "")),
  };
}

function isCidrItem(item: string): boolean {
  try {
    cidrMatcher([item]);
    return true;
  } catch {
    return false;
  }
}

/** The problems of `allow` items, one line each. */
export function allowProblems(items: readonly string[]): string[] {
  return items.flatMap((item, index) =>
    isCidrItem(item) || isHostPattern(item) ? [] : [`Invalid http.allow[${index}]: expected an address, a CIDR block or a host name, got ${JSON.stringify(item)}`],
  );
}

/** Resolves a host name to its addresses. */
export type Resolver = (host: string) => Promise<string[]>;

const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** The names a test maps to addresses: an address, a list, or a function called on each resolution. */
export type TestResolverMap = Readonly<Record<string, string | readonly string[] | (() => string | readonly string[])>>;

const resolverState = sharedState("resolver", () => ({ test: undefined as TestResolverMap | undefined }));

/** Resolves `host` with the test map when it names it, else with DNS. */
export async function resolveHost(host: string): Promise<string[]> {
  const mapped = resolverState.test?.[host.toLowerCase()];
  if (mapped !== undefined) {
    const value = typeof mapped === "function" ? mapped() : mapped;
    return typeof value === "string" ? [value] : [...value];
  }
  return dnsResolver(host);
}

/**
 * Maps host names to addresses for every outgoing call until the returned function is called; names it does not list
 * resolve with DNS. For tests.
 */
export function useTestResolver(map: TestResolverMap): () => void {
  const lowered = Object.fromEntries(Object.entries(map).map(([name, value]) => [name.toLowerCase(), value]));
  resolverState.test = lowered;
  return () => {
    if (resolverState.test === lowered) resolverState.test = undefined;
  };
}
