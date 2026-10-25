import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evaluateAudit, parseAuditOutput, type AuditAllowance } from "./audit.ts";

const output = JSON.stringify({
  "left-pad": [
    { id: 1001, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "Remote code execution", severity: "critical" },
    { id: 1002, url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", title: "Slow regex", severity: "moderate" },
  ],
  undici: [{ id: 1003, url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii", title: "Denial of service", severity: "high" }],
});
const allowance = (overrides: Partial<AuditAllowance> = {}): AuditAllowance => ({
  id: "GHSA-aaaa-bbbb-cccc",
  package: "left-pad",
  reason: "not reachable from the service",
  expires: "2026-12-31",
  ...overrides,
});

describe("dependency audit", () => {
  test("parses every advisory with its package", () => {
    expect(parseAuditOutput(output).map((item) => [item.package, item.id, item.severity])).toEqual([
      ["left-pad", 1001, "critical"],
      ["left-pad", 1002, "moderate"],
      ["undici", 1003, "high"],
    ]);
    expect(parseAuditOutput("{}")).toEqual([]);
    expect(parseAuditOutput("")).toEqual([]);
  });

  test("a critical vulnerability fails the audit and every vulnerability is printed", () => {
    const result = evaluateAudit(parseAuditOutput(output), [], "2026-10-25");
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("critical: left-pad GHSA-aaaa-bbbb-cccc Remote code execution (not allowed)");
    expect(result.lines).toContain("moderate: left-pad GHSA-dddd-eeee-ffff Slow regex");
    expect(result.lines).toContain("high: undici GHSA-gggg-hhhh-iiii Denial of service");
  });

  test("vulnerabilities below critical do not fail", () => {
    const result = evaluateAudit(parseAuditOutput(output).filter((item) => item.severity !== "critical"), [], "2026-10-25");
    expect(result.ok).toBe(true);
  });

  test("an allowance by GHSA or numeric id lets a critical one pass until it expires", () => {
    const vulnerabilities = parseAuditOutput(output);
    expect(evaluateAudit(vulnerabilities, [allowance()], "2026-10-25").ok).toBe(true);
    expect(evaluateAudit(vulnerabilities, [allowance({ id: "1001" })], "2026-10-25").ok).toBe(true);
    expect(evaluateAudit(vulnerabilities, [allowance({ expires: "2026-10-25" })], "2026-10-25").ok).toBe(true);
    expect(evaluateAudit(vulnerabilities, [allowance({ package: "other" })], "2026-10-25").ok).toBe(false);
  });

  test("an expired allowance is reported and allows nothing", () => {
    const result = evaluateAudit(parseAuditOutput(output), [allowance({ expires: "2026-10-01" })], "2026-10-25");
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("Audit allowance GHSA-aaaa-bbbb-cccc expired on 2026-10-01");
  });
});

if (process.env.CI) {
  test("dependency audit", async () => {
    const child = Bun.spawn(["bun", "run", "audit"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`bun run audit failed:\n${stdout}${stderr}`);
    expect(code).toBe(0);
  }, 120_000);
} else {
  test.skip("dependency audit (set CI=1 to run; needs network)", () => {});
}
