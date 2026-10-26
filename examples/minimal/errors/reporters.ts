import type { ErrorReport, ErrorReporter } from "@quickservice/core";

/** Keeps every report in memory, as the tests read them. */
export function memoryReporter(): ErrorReporter & { reports: ErrorReport[] } {
  const reports: ErrorReport[] = [];
  return { reports, report: (report) => void reports.push(report) };
}
