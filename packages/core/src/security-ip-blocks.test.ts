import { afterEach, describe, expect, test } from "bun:test";
import type { LogEntry } from "./logger.ts";
import { AutoBlocker, IpBlockList, type IpUnblockEvent } from "./features/security/ip-blocks.ts";
import { ipStep } from "./features/security/ip.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => void (logs.length = 0));

const MINUTE = 60_000;
/** A block list on a clock the test moves. */
function clocked(maxEntries = 100) {
  const clock = { now: Date.UTC(2026, 9, 28, 12) };
  const unblocked: IpUnblockEvent[] = [];
  const list = new IpBlockList({ maxEntries, logger, onBlock: [], onUnblock: [(event) => void unblocked.push(event)], now: () => clock.now });
  return { list, clock, unblocked };
}

describe("expiry and cleanup", () => {
  test("a block stops applying at its until, and cleanup removes it, logging security.ip.unblocked with reason expired", async () => {
    const { list, clock, unblocked } = clocked();
    const block = await list.block("203.0.113.9", { for: "10m" });
    expect(list.matches("203.0.113.9")).toBe(true);
    clock.now += 10 * MINUTE;
    expect(list.matches("203.0.113.9")).toBe(false);
    expect(list.size).toBe(1);
    expect(await list.cleanup(false)).toBe(1);
    expect(list.size).toBe(0);
    expect(unblocked).toEqual([{ cidr: "203.0.113.9", reason: "expired", until: block.until }]);
    expect(logs.find((entry) => entry.message === "security.ip.unblocked")).toMatchObject({ cidr: "203.0.113.9", reason: "expired", until: block.until.toISOString() });
  });

  test("a second block of the same cidr keeps the later until, and the block closest to expiry is evicted past maxEntries", async () => {
    const { list } = clocked(2);
    const long = await list.block("192.0.2.1", { for: "30m" });
    expect((await list.block("192.0.2.1", { for: "5m", reason: "again" })).until).toEqual(long.until);
    await list.block("192.0.2.2", { for: "1m" });
    await list.block("192.0.2.3", { for: "2m" });
    expect((await list.blocked()).map((block) => block.cidr).sort()).toEqual(["192.0.2.1", "192.0.2.3"]);
  });
});

describe("automatic blocking", () => {
  test("the sliding window blocks at the threshold with the auto reason, and counters stay bounded", async () => {
    const { list, clock } = clocked();
    const blocker = new AutoBlocker({ after: 3, withinMs: MINUTE, withinText: "1m", forText: "15m", statuses: [401], maxEntries: 2, now: () => clock.now }, list, logger);
    blocker.count("192.0.2.9");
    blocker.count("192.0.2.9");
    expect(list.size).toBe(0);
    blocker.count("192.0.2.9");
    await Bun.sleep(1);
    expect(await list.blocked()).toEqual([expect.objectContaining({ cidr: "192.0.2.9/32", source: "auto", reason: "auto: 3 responses with 401 within 1m" })]);
    blocker.count("2001:db8::1");
    blocker.count("2001:db8::1");
    blocker.count("2001:db8::1");
    await Bun.sleep(1);
    expect((await list.blocked()).map((block) => block.cidr)).toContain("2001:db8::1/128");
  });
});

describe("the fast path", () => {
  test("without autoBlock the step has no work on responses, and with no block stored it does only a size check", () => {
    let matched = 0;
    const blocks = { size: 0, matches: () => (matched++, false) };
    const step = ipStep({ allow: [], deny: [] }, () => "192.0.2.1", [], undefined, { blocks })!;
    expect(step.after).toBeUndefined();
    step.before!({ exempt: 0, ctx: { request: new Request("http://localhost/") } } as never);
    expect(matched).toBe(0);
    const auto = ipStep({ allow: [], deny: [] }, () => "192.0.2.1", [], undefined, { blocks, auto: { statuses: new Set([401]), count() {}, exempt: () => false } })!;
    expect(auto.after).toBeDefined();
  });
});
