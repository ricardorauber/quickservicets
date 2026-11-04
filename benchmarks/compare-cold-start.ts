#!/usr/bin/env bun
/**
 * Compares a cold-start result with the baseline: the committed benchmarks/results/cold-start.json, or --baseline.
 * Exits 1 when a target's p50 or size grew more than 10%. --update makes the result the new baseline.
 *
 *   bun benchmarks/compare-cold-start.ts benchmarks/results/cold-start.json
 *   bun benchmarks/compare-cold-start.ts /tmp/cold-start.json --baseline old.json
 *   bun benchmarks/compare-cold-start.ts /tmp/cold-start.json --update
 */
import { copyFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ColdStartResult } from "./cold-start.ts";

const ROOT = resolve(import.meta.dir, "..");
/** The committed result, the default baseline. */
export const BASELINE = join(ROOT, "benchmarks/results/cold-start.json");
/** How much slower or larger a target may get, in percent. */
export const BUDGET_PERCENT = 10;

/** The lines of the targets over the budget, empty when every target holds it. */
export function coldStartProblems(baseline: ColdStartResult, result: ColdStartResult, budget = BUDGET_PERCENT): string[] {
  const problems: string[] = [];
  for (const [target, after] of Object.entries(result.targets)) {
    const before = baseline.targets[target as keyof ColdStartResult["targets"]];
    if (!before || !after) continue;
    const slower = before.p50 > 0 ? ((after.p50 - before.p50) / before.p50) * 100 : 0;
    if (slower > budget) problems.push(`${target} cold start ${Math.round(slower)}% slower (${before.p50} ms → ${after.p50} ms); the budget is ${budget}%`);
    const larger = before.bytes > 0 ? ((after.bytes - before.bytes) / before.bytes) * 100 : 0;
    if (larger > budget) problems.push(`${target} size ${Math.round(larger)}% larger (${before.bytes} bytes → ${after.bytes} bytes); the budget is ${budget}%`);
  }
  return problems;
}

/** The baseline: a file given with --baseline, or the result committed in git (or, outside git, the file on disk). */
function readBaseline(file: string | undefined): ColdStartResult {
  if (file) return JSON.parse(readFileSync(file, "utf8")) as ColdStartResult;
  const committed = Bun.spawnSync(["git", "show", "HEAD:benchmarks/results/cold-start.json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return JSON.parse(committed.exitCode === 0 ? committed.stdout.toString() : readFileSync(BASELINE, "utf8")) as ColdStartResult;
}

/** `bun benchmarks/compare-cold-start.ts <result> [--baseline <file>] [--update]`; resolves the exit code. */
export function main(args: readonly string[], log: (line: string) => void = console.log, error: (line: string) => void = console.error): number {
  const [file] = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--baseline");
  if (!file) {
    error("Usage: bun benchmarks/compare-cold-start.ts <result> [--baseline <file>] [--update]");
    return 2;
  }
  const result = JSON.parse(readFileSync(file, "utf8")) as ColdStartResult;
  if (args.includes("--update")) {
    if (resolve(file) !== BASELINE) copyFileSync(file, BASELINE);
    log(`Updated ${BASELINE}; commit it as the new baseline`);
    return 0;
  }
  const at = args.indexOf("--baseline");
  const baseline = readBaseline(at >= 0 ? args[at + 1] : undefined);
  const problems = coldStartProblems(baseline, result);
  for (const [target, after] of Object.entries(result.targets)) {
    const before = baseline.targets[target as keyof ColdStartResult["targets"]];
    log(`${target}: p50 ${before?.p50 ?? "-"} ms → ${after?.p50} ms, size ${before?.bytes ?? "-"} → ${after?.bytes} bytes`);
  }
  for (const problem of problems) error(problem);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
