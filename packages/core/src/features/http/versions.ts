import type { ServiceInstance } from "../public.ts";

const PART = "(?:\\d+|[xX*])";
const COMPARATOR = new RegExp(`^(?:\\^|~|>=|<=|>|<|=)?v?${PART}(?:\\.${PART}){0,2}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`);

/** Whether a text is a semantic version range, like `^2`, `~2.3`, `>=2.1 <3`, `1.x || 2.x` or `1.0.0 - 2.0.0`. */
export function isVersionRange(range: string): boolean {
  const sets = range.split("||").map((set) => set.trim());
  if (sets.length === 0 || sets.some((set) => set === "")) return false;
  return sets.every((set) => {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) return COMPARATOR.test(hyphen[1]!) && COMPARATOR.test(hyphen[2]!) && !/^[\^~<>=]/.test(hyphen[1]!) && !/^[\^~<>=]/.test(hyphen[2]!);
    // Operators may be written apart from their version, like `>= 2.1`.
    const tokens = set.replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
    return tokens.every((token) => COMPARATOR.test(token));
  });
}

/** The message of a `discover` option whose range is not valid. */
export const invalidRange = (service: string, range: string) => `Invalid http.services.${service}.discover: ${range} is not a version range`;

/** The message of a call whose service has instances, none of whose versions matches its range. */
export function noMatchingVersion(name: string, range: string, instances: readonly ServiceInstance[]): string {
  const versions = [...new Set(instances.flatMap((instance) => (instance.version !== undefined ? [instance.version] : [])))].sort((a, b) => Bun.semver.order(a, b)).slice(0, 10);
  return `No instances of ${name} match ${range} (found ${versions.length > 0 ? versions.join(", ") : "no versions"})`;
}

/**
 * The instances whose version satisfies `range` (those without a version only with `allowUnversioned`); with
 * `prefer: "highest"`, only those of the highest matching version.
 */
export function matchingInstances(instances: readonly ServiceInstance[], range: string | undefined, options: { prefer: "any" | "highest"; allowUnversioned: boolean }): ServiceInstance[] {
  if (range === undefined) return [...instances];
  const matching = instances.filter((instance) => (instance.version === undefined ? options.allowUnversioned : Bun.semver.satisfies(instance.version, range)));
  if (options.prefer !== "highest") return matching;
  const versions = matching.flatMap((instance) => (instance.version !== undefined ? [instance.version] : []));
  if (versions.length === 0) return matching;
  const highest = versions.reduce((best, version) => (Bun.semver.order(version, best) > 0 ? version : best));
  return matching.filter((instance) => instance.version === highest);
}
