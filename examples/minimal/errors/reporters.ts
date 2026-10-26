import { appendFileSync } from "node:fs";
import type { ErrorReport, ErrorReporter } from "@quickservice/core";

/** Keeps every report in memory, as the tests read them. */
export function memoryReporter(): ErrorReporter & { reports: ErrorReport[] } {
  const reports: ErrorReport[] = [];
  return { reports, report: (report) => void reports.push(report) };
}

/** Appends each report to a JSON-lines file, one report per line. */
export function jsonLinesReporter(path: string): ErrorReporter {
  return { report: (report) => appendFileSync(path, `${JSON.stringify(report)}\n`) };
}
