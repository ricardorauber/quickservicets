const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Parses sizes such as `10MB` or `512 KB` (base 1024) into bytes; returns undefined when invalid. */
export function parseSize(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(value.trim());
  if (!match) return undefined;
  return Math.floor(Number(match[1]) * UNITS[match[2]!.toUpperCase()]!);
}

export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 ** 2;

/** Whether a MIME type matches one of the patterns (`image/png`, `image/*`, `*\/*`). */
export function mimeMatches(type: string, patterns: readonly string[]): boolean {
  const [kind = "", subtype = ""] = type.toLowerCase().split(";")[0]!.trim().split("/");
  return patterns.some((pattern) => {
    const [patternKind = "", patternSubtype = ""] = pattern.toLowerCase().trim().split("/");
    return (patternKind === "*" || patternKind === kind) && (patternSubtype === "*" || patternSubtype === subtype);
  });
}

/** Base name without path segments or control characters, at most 255 characters. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
}
