import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as runScenario, measureColdStart, medianPhases, percentile, type ColdStartResult } from "./cold-start.ts";
import { coldStartProblems, main as compare } from "./compare-cold-start.ts";

describe("the measurement loop", () => {
  test("each start runs after the previous one, and p50 and p90 come from every run", async () => {
    let running = 0;
    let order = 0;
    const launch = async () => {
      expect(running).toBe(0);
      running++;
      await Bun.sleep(1);
      running--;
      return { ms: 10 * ++order, output: "" };
    };
    const result = await measureColdStart(launch, 10, 1234);
    expect(result.runs).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(result.p50).toBe(50);
    expect(result.p90).toBe(90);
    expect(result.bytes).toBe(1234);
    expect(percentile([], 50)).toBe(0);
  });

  test("the phases of the service.started entries are their medians", () => {
    const entry = (config: number) => JSON.stringify({ message: "service.started", phases: { config, setup: 2, connect: 3, start: 4 } });
    expect(medianPhases([`not json\n${entry(1)}`, entry(5), entry(3)])).toEqual({ config: 3, setup: 2, connect: 3, start: 4 });
    expect(medianPhases(["{}"])).toBeUndefined();
  });
});

describe("result files", () => {
  test("the scenario builds the three targets and writes p50, p90 and size per target, with the server's phases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-cold-result-"));
    try {
      const out = join(dir, "cold-start.json");
      expect(await runScenario(["--runs", "2", "--out", out])).toBe(0);
      const result = JSON.parse(readFileSync(out, "utf8")) as ColdStartResult;
      expect(result).toMatchObject({ scenario: "cold-start", bun: Bun.version, machine: { platform: process.platform, arch: process.arch } });
      expect(Object.keys(result.targets)).toEqual(["server", "binary", "lambda"]);
      for (const target of Object.values(result.targets)) {
        expect(target!.runs).toHaveLength(2);
        expect(target!.p50).toBeGreaterThan(0);
        expect(target!.p90).toBeGreaterThanOrEqual(target!.p50);
        expect(target!.bytes).toBeGreaterThan(0);
      }
      expect(result.targets.server!.phases).toEqual({ config: expect.any(Number), setup: expect.any(Number), connect: expect.any(Number), start: expect.any(Number) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("comparison and budgets", () => {
  const result = (server: number, binary: number, bytes = 1000): ColdStartResult => ({
    scenario: "cold-start",
    date: "2026-11-04T00:00:00.000Z",
    bun: "1.4.2",
    machine: { platform: "darwin", arch: "arm64", cpu: "test", cpus: 1 },
    targets: { server: { p50: server, p90: server, runs: [server], bytes }, binary: { p50: binary, p90: binary, runs: [binary], bytes } },
  });

  test("5% slower holds the budget; 15% slower or 12% larger fails with the message", () => {
    expect(coldStartProblems(result(100, 100), result(105, 105))).toEqual([]);
    expect(coldStartProblems(result(100, 100), result(100, 115))).toEqual(["binary cold start 15% slower (100 ms → 115 ms); the budget is 10%"]);
    expect(coldStartProblems(result(100, 100, 1000), result(100, 100, 1120))).toEqual([
      "server size 12% larger (1000 bytes → 1120 bytes); the budget is 10%",
      "binary size 12% larger (1000 bytes → 1120 bytes); the budget is 10%",
    ]);
  });

  test("the command exits 0 within the budget and 1 over it, against --baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-cold-compare-"));
    try {
      writeFileSync(join(dir, "baseline.json"), JSON.stringify(result(100, 100)));
      writeFileSync(join(dir, "ok.json"), JSON.stringify(result(105, 105)));
      writeFileSync(join(dir, "slow.json"), JSON.stringify(result(100, 115)));
      const errors: string[] = [];
      expect(compare([join(dir, "ok.json"), "--baseline", join(dir, "baseline.json")], () => {}, (line) => errors.push(line))).toBe(0);
      expect(compare([join(dir, "slow.json"), "--baseline", join(dir, "baseline.json")], () => {}, (line) => errors.push(line))).toBe(1);
      expect(errors).toEqual(["binary cold start 15% slower (100 ms → 115 ms); the budget is 10%"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
