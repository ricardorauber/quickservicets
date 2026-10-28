/** The items a path can be exempted from, as `exempt(pattern, items)` names them. */
export const EXEMPTIBLE_ITEMS = ["rateLimit", "loadShedding", "ip", "cors", "headers", "mtls"] as const;

/** An item a path can be exempted from, or `all` of them. */
export type ExemptibleItem = (typeof EXEMPTIBLE_ITEMS)[number] | "all";

/** The bit of each exemptible item in the mask `Exemptions.match` returns. */
export const EXEMPT: Readonly<Record<(typeof EXEMPTIBLE_ITEMS)[number], number>> = { rateLimit: 1, loadShedding: 2, ip: 4, cors: 8, headers: 16, mtls: 32 };

const ALL = 63;

/**
 * The paths exempted from security items: exact paths, and prefixes written as a path ending in `/*`, which match the
 * path itself and every path below it. Exemptions are added during setup only; `close()` compiles them, and
 * `match(path)` then returns the mask of exempted items with one map lookup and one pass over the prefixes.
 */
export class Exemptions {
  private readonly exact = new Map<string, number>();
  private readonly prefixes = new Map<string, number>();
  private compiled: { prefix: string; base: string; mask: number }[] = [];
  private closed = false;
  /** True when no path is exempted, so a request skips the lookup. */
  empty = true;

  add(pattern: string, items: readonly ExemptibleItem[]): void {
    if (this.closed) throw new Error("security exempt() is only available during setup");
    if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error(`Invalid security exemption ${JSON.stringify(pattern)}: expected a path like /health or /health/*`);
    if (!Array.isArray(items) || items.length === 0) throw new Error(`Invalid security exemption of ${pattern}: expected a list of ${[...EXEMPTIBLE_ITEMS, "all"].join(", ")}`);
    let mask = 0;
    for (const item of items as readonly string[]) {
      if (item === "all") mask |= ALL;
      else if (Object.hasOwn(EXEMPT, item)) mask |= EXEMPT[item as keyof typeof EXEMPT];
      else throw new Error(`Invalid security exemption of ${pattern}: unknown item ${JSON.stringify(item)}; expected ${[...EXEMPTIBLE_ITEMS, "all"].join(", ")}`);
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      this.prefixes.set(prefix, (this.prefixes.get(prefix) ?? 0) | mask);
    } else {
      this.exact.set(pattern, (this.exact.get(pattern) ?? 0) | mask);
    }
    this.empty = false;
  }

  /** Ends the setup: later `add` calls throw, and the prefixes are compiled for matching. */
  close(): void {
    this.closed = true;
    this.compiled = [...this.prefixes].map(([prefix, mask]) => ({ prefix, base: prefix.slice(0, -1), mask }));
  }

  /** The mask of the items `path` is exempted from (0 for none). */
  match(path: string): number {
    if (this.empty) return 0;
    let mask = this.exact.get(path) ?? 0;
    for (const entry of this.compiled) {
      if (path === entry.base || path.startsWith(entry.prefix)) mask |= entry.mask;
    }
    return mask;
  }
}
