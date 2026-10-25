/**
 * Audits the workspace's dependencies with `bun audit`: `bun run audit`. Prints every reported vulnerability and exits 1
 * when a critical one is not allowed by `scripts/audit-allow.json`. `--input <file>` reads a saved `bun audit --json`
 * output instead of running it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export const ALLOW_FILE = join(import.meta.dir, "audit-allow.json");

/** One advisory reported by `bun audit --json`, keyed there by package name. */
export interface Advisory {
  id: number | string;
  url?: string;
  title: string;
  severity: string;
  vulnerable_versions?: string;
}

export interface Vulnerability extends Advisory {
  package: string;
}

/** An entry of `scripts/audit-allow.json`: a vulnerability accepted until `expires` (YYYY-MM-DD). */
export interface AuditAllowance {
  /** The advisory's GHSA identifier (as in its URL) or its numeric id. */
  id: string;
  package: string;
  reason: string;
  expires: string;
}

export interface AuditResult {
  ok: boolean;
  lines: string[];
}

/** The vulnerabilities of a `bun audit --json` output. */
export function parseAuditOutput(output: string): Vulnerability[] {
  const parsed = JSON.parse(output.trim() === "" ? "{}" : output) as Record<string, Advisory[]>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Unexpected bun audit output");
  return Object.entries(parsed).flatMap(([name, advisories]) => (Array.isArray(advisories) ? advisories.map((advisory) => ({ ...advisory, package: name })) : []));
}

/** The identifiers an allowance may use for a vulnerability: its numeric id and the GHSA id of its URL. */
function identifiers(vulnerability: Vulnerability): string[] {
  const ghsa = vulnerability.url?.match(/GHSA(-[0-9a-z]{4}){3}/i)?.[0];
  return [String(vulnerability.id), ...(ghsa ? [ghsa] : [])];
}

/** Decides the audit: every vulnerability is listed, and only critical ones without a valid allowance fail it. */
export function evaluateAudit(vulnerabilities: Vulnerability[], allowances: AuditAllowance[], today: string): AuditResult {
  const lines: string[] = [];
  const active = allowances.filter((allowance) => {
    if (allowance.expires >= today) return true;
    lines.push(`Audit allowance ${allowance.id} expired on ${allowance.expires}`);
    return false;
  });
  let failed = false;
  for (const vulnerability of vulnerabilities) {
    const ids = identifiers(vulnerability);
    const allowance = active.find((entry) => entry.package === vulnerability.package && ids.includes(entry.id));
    const critical = vulnerability.severity === "critical";
    const status = critical ? (allowance ? ` (allowed until ${allowance.expires}: ${allowance.reason})` : " (not allowed)") : "";
    if (critical && !allowance) failed = true;
    lines.push(`${vulnerability.severity}: ${vulnerability.package} ${ids[ids.length - 1]} ${vulnerability.title}${status}`);
  }
  lines.push(vulnerabilities.length === 0 ? "No vulnerabilities found" : `${vulnerabilities.length} ${vulnerabilities.length === 1 ? "vulnerability" : "vulnerabilities"}${failed ? "; critical ones are not allowed" : ""}`);
  return { ok: !failed, lines };
}

export function readAllowances(file = ALLOW_FILE): AuditAllowance[] {
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(entries)) throw new Error(`${file} must hold an array of { id, package, reason, expires }`);
  for (const entry of entries as Partial<AuditAllowance>[]) {
    const valid = ["id", "package", "reason", "expires"].every((key) => typeof entry?.[key as keyof AuditAllowance] === "string" && entry[key as keyof AuditAllowance] !== "");
    if (!valid || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires!)) {
      throw new Error(`${file}: each entry needs id, package, reason and expires (YYYY-MM-DD), got ${JSON.stringify(entry)}`);
    }
  }
  return entries as AuditAllowance[];
}

async function auditOutput(input: string | undefined): Promise<string> {
  if (input) return readFileSync(input, "utf8");
  // `bun audit` exits 1 whenever it reports a vulnerability; the JSON decides.
  const child = Bun.spawn(["bun", "audit", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (stdout.trim() === "" && stderr.trim() !== "") throw new Error(`bun audit failed: ${stderr.trim()}`);
  return stdout;
}

if (import.meta.main) {
  const inputAt = process.argv.indexOf("--input");
  const input = inputAt >= 0 ? process.argv[inputAt + 1] : undefined;
  try {
    const result = evaluateAudit(parseAuditOutput(await auditOutput(input)), readAllowances(), new Date().toISOString().slice(0, 10));
    for (const line of result.lines) console.log(line);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
