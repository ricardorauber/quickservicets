#!/usr/bin/env bun
/**
 * Compares a benchmark result with the baseline (every native at its default):
 *
 *   bun benchmarks/compare-features.ts benchmarks/results/features/events-off.json
 *   bun benchmarks/compare-features.ts <result> --baseline benchmarks/results/quickservicets.json
 *
 * Prints the change of req/s, p50 and p99 per scenario, and exits 1 when a budget check fails (see features.ts).
 */
import { join } from "node:path";
import { compareResults, type BenchResult } from "./features.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--baseline");
const baselineFile = at >= 0 ? args[at + 1] : join(import.meta.dir, "results", "quickservicets.json");
const runFile = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1);
if (!runFile || !baselineFile) {
  console.error("Usage: bun benchmarks/compare-features.ts <result> [--baseline <file>]");
  process.exit(2);
}
const read = async (file: string) => JSON.parse(await Bun.file(file).text()) as BenchResult;
const { lines, failures } = compareResults(await read(runFile), await read(baselineFile));
for (const line of lines) console.log(line);
for (const failure of failures) console.error(failure);
process.exit(failures.length === 0 ? 0 : 1);
