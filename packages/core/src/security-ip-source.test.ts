import { afterEach, describe, expect, test } from "bun:test";
import { cidrMatcher } from "./cidr.ts";
import type { LogEntry } from "./logger.ts";
import { dynamicIpLists, type IpListSource } from "./features/security/ip-source.ts";
import { ipStep } from "./features/security/ip.ts";
import { provider } from "./options.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
const stops: (() => void)[] = [];
afterEach(() => {
  logs.length = 0;
  for (const stop of stops.splice(0)) stop();
});

type Lists = { allow: string[]; deny: string[] };
/** A source whose lists and load delay the test changes, counting its loads and keeping its watcher. */
function testSource(initial: Lists) {
  const state = { lists: initial, loads: 0, delayMs: 0, fail: undefined as Error | undefined, notify: undefined as (() => void) | undefined };
  const source: IpListSource = {
    async load() {
      state.loads += 1;
      if (state.delayMs > 0) await Bun.sleep(state.delayMs);
      if (state.fail) throw state.fail;
      return structuredClone(state.lists);
    },
    watch(onChange) {
      state.notify = onChange;
      return () => (state.notify = undefined);
    },
  };
  return { source, state };
}
const passes = (lists: { check: ((address: string) => boolean) | undefined }, address: string) => lists.check?.(address) ?? true;
const settle = async (check: () => boolean) => {
  for (let tries = 0; tries < 400 && !check(); tries++) await Bun.sleep(5);
};

describe("options", () => {
  test("source is an IpListSource provider with load, and watch is optional", () => {
    const schema = provider<IpListSource>("IpListSource", ["load"]);
    expect(schema.kind).toBe("provider");
    const { source } = testSource({ allow: [], deny: [] });
    const lists = dynamicIpLists({ config: { allow: [], deny: [] }, source: { load: source.load }, refreshMs: 1000, logger });
    expect(lists.check).toBeUndefined();
  });
});

describe("scheduling", () => {
  test("loads at start, after refresh, at once on watch, and three notifications during one load cause one more load", async () => {
    const { source, state } = testSource({ allow: [], deny: ["203.0.113.0/24"] });
    const lists = dynamicIpLists({ config: { allow: [], deny: [] }, source, refreshMs: 150, logger });
    stops.push(() => lists.stop());
    await lists.start();
    expect(state.loads).toBe(1);
    expect(passes(lists, "203.0.113.9")).toBe(false);

    state.lists = { allow: [], deny: ["198.51.100.0/24"] };
    await settle(() => !passes(lists, "198.51.100.1"));
    expect(passes(lists, "198.51.100.1")).toBe(false);
    expect(passes(lists, "203.0.113.9")).toBe(true);
    lists.stop();

    const watched = testSource({ allow: [], deny: [] });
    const fast = dynamicIpLists({ config: { allow: [], deny: [] }, source: watched.source, refreshMs: 60_000, logger });
    stops.push(() => fast.stop());
    await fast.start();
    watched.state.lists = { allow: [], deny: ["192.0.2.1"] };
    watched.state.notify!();
    await settle(() => !passes(fast, "192.0.2.1"));
    expect(passes(fast, "192.0.2.1")).toBe(false);

    const loadsBefore = watched.state.loads;
    watched.state.delayMs = 50;
    const first = fast.reload();
    watched.state.notify!();
    watched.state.notify!();
    watched.state.notify!();
    await first;
    await settle(() => watched.state.loads >= loadsBefore + 2);
    await Bun.sleep(120);
    expect(watched.state.loads).toBe(loadsBefore + 2);
  });
});

describe("merging and swapping", () => {
  test("config and loaded lists merge, invalid entries are skipped and logged, and each request sees one whole version", async () => {
    const { source, state } = testSource({ allow: [], deny: ["10.0.0.300", "203.0.113.0/24"] });
    const lists = dynamicIpLists({ config: { allow: [], deny: ["198.51.100.7"] }, source, refreshMs: 60_000, logger });
    stops.push(() => lists.stop());
    expect(await lists.reload()).toEqual({ allow: 0, deny: 2 });
    expect(passes(lists, "198.51.100.7")).toBe(false);
    expect(passes(lists, "203.0.113.9")).toBe(false);
    expect(passes(lists, "192.0.2.1")).toBe(true);
    expect(logs.filter((entry) => entry.message === "security.ip.source.invalid")).toEqual([expect.objectContaining({ entry: "10.0.0.300" })]);

    // Version 1 allows only A; version 2 allows only B. A slow compile stub runs while requests keep checking.
    const A = "192.0.2.10";
    const B = "192.0.2.20";
    let compiles = 0;
    const slowCompile = (entries: readonly string[]) => {
      compiles += 1;
      const until = performance.now() + 20;
      while (performance.now() < until);
      return cidrMatcher(entries);
    };
    const versioned = testSource({ allow: [A], deny: [] });
    const swapping = dynamicIpLists({ config: { allow: [], deny: [] }, source: versioned.source, refreshMs: 60_000, logger, compile: slowCompile });
    stops.push(() => swapping.stop());
    await swapping.reload();
    versioned.state.lists = { allow: [B], deny: [A] };
    versioned.state.delayMs = 10;
    const seen = new Set<string>();
    const reload = swapping.reload();
    for (let i = 0; i < 40; i++) {
      seen.add(`${passes(swapping, A)}/${passes(swapping, B)}`);
      await Bun.sleep(1);
    }
    await reload;
    seen.add(`${passes(swapping, A)}/${passes(swapping, B)}`);
    expect(compiles).toBeGreaterThanOrEqual(2);
    expect([...seen].sort()).toEqual(["false/true", "true/false"]);
  });
});

describe("failures", () => {
  test("a rejecting or slow load keeps the lists and logs once per minute, and a failing first load keeps the config lists", async () => {
    let now = 1_000_000;
    const { source, state } = testSource({ allow: [], deny: ["203.0.113.0/24"] });
    state.fail = new Error("database down");
    const lists = dynamicIpLists({ config: { allow: [], deny: ["198.51.100.7"] }, source, refreshMs: 100, logger, now: () => now });
    stops.push(() => lists.stop());
    await lists.start();
    expect(passes(lists, "198.51.100.7")).toBe(false);
    expect(passes(lists, "203.0.113.9")).toBe(true);
    await expect(lists.reload()).rejects.toThrow("database down");
    await expect(lists.reload()).rejects.toThrow("database down");
    expect(logs.filter((entry) => entry.message === "security.ip.source.failed")).toEqual([expect.objectContaining({ reason: "database down" })]);
    now += 61_000;
    await expect(lists.reload()).rejects.toThrow("database down");
    expect(logs.filter((entry) => entry.message === "security.ip.source.failed")).toHaveLength(2);

    state.fail = undefined;
    await lists.reload();
    expect(passes(lists, "203.0.113.9")).toBe(false);
    state.lists = { allow: [], deny: [] };
    state.delayMs = 300;
    now += 61_000;
    await expect(lists.reload()).rejects.toThrow("the load took longer than 100ms");
    expect(passes(lists, "203.0.113.9")).toBe(false);
  });
});

describe("the no-source path", () => {
  test("without a source, the step compiles the config lists once and nothing else", () => {
    let compiles = 0;
    const counting = (entries: readonly string[]) => (compiles++, cidrMatcher(entries));
    expect(ipStep({ allow: [], deny: [] }, () => "127.0.0.1", [], counting)).toBeUndefined();
    expect(compiles).toBe(0);
    expect(ipStep({ allow: [], deny: ["198.51.100.7"] }, () => "127.0.0.1", [], counting)).toBeDefined();
    expect(compiles).toBe(1);
  });
});
