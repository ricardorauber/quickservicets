/** What every printed or serialized secret value is replaced with. */
export const SECRET_MASK = "[secret]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** The paths each object prints masked. */
const maskedPaths = new WeakMap<object, string[]>();

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
  // Paths masked earlier stay masked, like the keys whose references resolved after the options did.
  const all = [...new Set([...(maskedPaths.get(target) ?? []), ...paths])];
  maskedPaths.set(target, all);
  const masked = () => maskedCopy(target, all);
  Object.defineProperty(target, "toJSON", { value: masked, enumerable: false, configurable: true });
  Object.defineProperty(target, INSPECT, { value: masked, enumerable: false, configurable: true });
}

/** Replaces every text of `secrets` and the password of any URL in `message` with the secret mask. */
export function maskConnections(message: string, secrets: readonly unknown[]): string {
  let masked = message;
  for (const secret of secrets) {
    const texts = typeof secret === "string" ? [secret] : secret && typeof secret === "object" ? Object.values(secret).filter((value): value is string => typeof value === "string") : [];
    for (const text of texts) if (text.length >= 4) masked = masked.split(text).join(SECRET_MASK);
  }
  return masked.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):[^@/\s]*@/gi, `$1:${SECRET_MASK}@`);
}
