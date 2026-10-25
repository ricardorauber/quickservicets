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
