/** A compiled event pattern: tells whether an event type matches it. */
export type CompiledPattern = (type: string) => boolean;

const SEGMENT = /^[a-z][A-Za-z0-9-]*$/;
const WRITE_OPERATIONS = ["created", "updated", "deleted"];
const RESERVED_ENDINGS = [...WRITE_OPERATIONS, "written"];
const CUSTOM_TYPE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9-]*)+$/;

/**
 * Compiles a pattern once: an exact type, segments of `*` matching exactly one segment (`user.*`, `*.created`), the
 * lone `*` matching every event, or `<entity>.written` / `*.written` matching that entity's created, updated and
 * deleted events. Throws `Invalid event pattern <pattern>` otherwise.
 */
export function compilePattern(pattern: string): CompiledPattern {
  if (pattern === "*") return () => true;
  const segments = typeof pattern === "string" ? pattern.split(".") : [];
  if (segments.length < 2 || !segments.every((segment) => segment === "*" || SEGMENT.test(segment))) throw new Error(`Invalid event pattern ${pattern}`);
  if (segments.at(-1) === "written") {
    const entity = segments.slice(0, -1);
    return (type) => {
      const parts = type.split(".");
      return parts.length === entity.length + 1 && WRITE_OPERATIONS.includes(parts.at(-1)!) && entity.every((segment, index) => segment === "*" || segment === parts[index]);
    };
  }
  if (!segments.includes("*")) return (type) => type === pattern;
  return (type) => {
    const parts = type.split(".");
    return parts.length === segments.length && segments.every((segment, index) => segment === "*" || segment === parts[index]);
  };
}

/** Whether a compiled pattern matches a type; dispatch calls it only the first time it meets a type. */
export function patternMatches(pattern: CompiledPattern, type: string): boolean {
  return pattern(type);
}

/**
 * Checks the type of a custom event: at least two lowercase dot-separated segments (`invoice.paid`), not ending with a
 * write operation or `written`. Throws `Invalid event type <type>: <reason>` otherwise.
 */
export function assertCustomType(type: string): void {
  if (typeof type !== "string" || !CUSTOM_TYPE.test(type)) {
    throw new Error(`Invalid event type ${type}: expected lowercase dot-separated segments, at least two, like invoice.paid`);
  }
  const ending = type.split(".").at(-1)!;
  if (RESERVED_ENDINGS.includes(ending)) throw new Error(`Invalid event type ${type}: the endings created, updated, deleted and written belong to write events`);
}
