/** What every printed or serialized secret value is replaced with. */
export const SECRET_MASK = "[secret]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A shallow copy of `target` with the value at each present dotted path replaced by the mask. */
export function maskedCopy(target: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...target };
  for (const path of paths) {
    const [head, ...rest] = path.split(".");
    if (!(head! in copy) || copy[head!] === undefined || copy[head!] === null) continue;
    if (rest.length === 0) copy[head!] = SECRET_MASK;
    else if (isObject(copy[head!])) copy[head!] = maskedCopy(copy[head!] as Record<string, unknown>, [rest.join(".")]);
  }
  return copy;
}

/**
 * Makes `JSON.stringify`, `console.log` and `Bun.inspect` show `[secret]` at `paths` of `target` (dotted, relative to
 * it), while property reads keep returning the real values.
 */
export function maskSecrets(target: Record<string, unknown>, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const masked = () => maskedCopy(target, paths);
  Object.defineProperty(target, "toJSON", { value: masked, enumerable: false, configurable: true });
  Object.defineProperty(target, INSPECT, { value: masked, enumerable: false, configurable: true });
}
