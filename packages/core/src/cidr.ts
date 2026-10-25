/** An IP address as a number, with its family's bit count (32 for IPv4, 128 for IPv6). */
interface Address {
  bits: 32 | 128;
  value: bigint;
}

/** An address block: the addresses whose first `prefix` bits equal those of `base`. */
interface Block {
  bits: 32 | 128;
  base: bigint;
  prefix: number;
}

/** The blocks each name stands for, IPv4 and IPv6. */
export const NAMED_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
};

/** What a cidr option accepts, as written in error messages. */
export const CIDR_EXPECTATION = "an IP address, a CIDR block or loopback, private or linklocal";

function parseIpv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function parseIpv6(text: string): bigint | undefined {
  let input = text;
  // A trailing IPv4 part (`::ffff:10.1.2.3`) stands for the last two groups.
  let tail: bigint[] = [];
  if (input.includes(".")) {
    const at = input.lastIndexOf(":");
    if (at < 0) return undefined;
    const ipv4 = parseIpv4(input.slice(at + 1));
    if (ipv4 === undefined) return undefined;
    tail = [ipv4 >> 16n, ipv4 & 0xffffn];
    input = input.slice(0, at + 1);
    if (!input.endsWith("::")) input = input.slice(0, -1);
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groupsOf(halves[0]!);
  const rest = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (![...head, ...rest].every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return undefined;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return undefined;
  const hex = (group: string) => BigInt(`0x${group}`);
  const groups = [...head.map(hex), ...Array<bigint>(8 - given).fill(0n), ...rest.map(hex), ...tail];
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
}

const MAPPED_PREFIX = 0xffffn << 32n;

/** An address, with IPv4-mapped IPv6 addresses (`::ffff:10.1.2.3`) read as IPv4; undefined when it is not one. */
function parseAddress(text: string): Address | undefined {
  const trimmed = text.trim().replace(/%.*$/, "").replace(/^\[(.*)\]$/, "$1");
  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== undefined) return { bits: 32, value: ipv4 };
  if (!trimmed.includes(":")) return undefined;
  const ipv6 = parseIpv6(trimmed);
  if (ipv6 === undefined) return undefined;
  if (ipv6 >> 32n === MAPPED_PREFIX >> 32n) return { bits: 32, value: ipv6 & 0xffffffffn };
  return { bits: 128, value: ipv6 };
}

/** The blocks a text stands for: one for an address or CIDR block, several for a name; undefined when it is none. */
function parseBlocks(text: string): Block[] | undefined {
  const trimmed = text.trim();
  const named = NAMED_BLOCKS[trimmed];
  if (named) return named.map((block) => parseBlocks(block)![0]!);
  const [addressText, prefixText, ...extra] = trimmed.split("/");
  if (extra.length > 0 || addressText === undefined) return undefined;
  const address = parseAddress(addressText);
  if (!address) return undefined;
  // A prefix applies to the written family: `::ffff:10.0.0.0/104` is an IPv6 block over mapped addresses.
  const mapped = address.bits === 32 && addressText.includes(":");
  const bits: 32 | 128 = mapped ? 128 : address.bits;
  if (prefixText === undefined) return [{ ...address, base: address.value, prefix: address.bits }];
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > bits) return undefined;
  const prefix = Number(prefixText);
  if (mapped) {
    if (prefix < 96) return undefined;
    return [{ bits: 32, base: address.value, prefix: prefix - 96 }];
  }
  return [{ bits, base: address.value, prefix }];
}

/** Whether a text is an IP address, a CIDR block or one of the names `loopback`, `private` and `linklocal`. */
export function isCidr(text: unknown): boolean {
  return typeof text === "string" && parseBlocks(text) !== undefined;
}

function inBlock(address: Address, block: Block): boolean {
  if (address.bits !== block.bits) return false;
  const shift = BigInt(block.bits - block.prefix);
  return address.value >> shift === block.base >> shift;
}

/**
 * Whether `address` is inside `block`: an address, a CIDR block (`10.0.0.0/8`, `fd00::/8`) or the name `loopback`,
 * `private` or `linklocal`. IPv4-mapped IPv6 addresses are compared as IPv4; an invalid address matches nothing, and
 * an invalid block throws.
 */
export function matchesCidr(address: string, block: string): boolean {
  const blocks = parseBlocks(block);
  if (!blocks) throw new Error(`Invalid block ${JSON.stringify(block)}: expected ${CIDR_EXPECTATION}`);
  const parsed = parseAddress(address);
  return parsed !== undefined && blocks.some((candidate) => inBlock(parsed, candidate));
}

/** The text form of an address: dotted IPv4, or lowercase IPv6 with the longest run of zero groups compressed. */
function formatAddress(address: Address): string {
  if (address.bits === 32) return [24n, 16n, 8n, 0n].map((shift) => String((address.value >> shift) & 0xffn)).join(".");
  const groups = Array.from({ length: 8 }, (_, index) => Number((address.value >> BigInt(112 - index * 16)) & 0xffffn));
  // RFC 5952: the longest run of two or more zero groups (the first of equal ones) becomes `::`.
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > best.length && end - start >= 2) best = { start, length: end - start };
    start = end;
  }
  const hex = (list: number[]) => list.map((group) => group.toString(16)).join(":");
  if (best.start < 0) return hex(groups);
  return `${hex(groups.slice(0, best.start))}::${hex(groups.slice(best.start + best.length))}`;
}

/**
 * An address in its normal form, or undefined when the text is not one: brackets and a port removed
 * (`[2001:db8::1]:4711`, `203.0.113.5:8080`), IPv4-mapped IPv6 as IPv4, IPv6 lowercase and compressed.
 */
export function normalizeAddress(text: string): string | undefined {
  let candidate = text.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) candidate = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(candidate)) candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  const address = parseAddress(candidate);
  return address ? formatAddress(address) : undefined;
}

/**
 * A matcher of addresses against a list of entries (addresses, CIDR blocks or `loopback`, `private` and `linklocal`),
 * parsed once; an address that is not one matches nothing. Throws for an invalid entry.
 */
export function cidrMatcher(entries: readonly string[]): (address: string) => boolean {
  const blocks = entries.flatMap((entry) => {
    const parsed = parseBlocks(entry);
    if (!parsed) throw new Error(`Invalid block ${JSON.stringify(entry)}: expected ${CIDR_EXPECTATION}`);
    return parsed;
  });
  const v4 = blocks.filter((block) => block.bits === 32).map((block) => ({ shift: BigInt(32 - block.prefix), base: block.base >> BigInt(32 - block.prefix) }));
  const v6 = blocks.filter((block) => block.bits === 128).map((block) => ({ shift: BigInt(128 - block.prefix), base: block.base >> BigInt(128 - block.prefix) }));
  return (text) => {
    const address = parseAddress(text);
    if (!address) return false;
    for (const block of address.bits === 32 ? v4 : v6) if (address.value >> block.shift === block.base) return true;
    return false;
  };
}
