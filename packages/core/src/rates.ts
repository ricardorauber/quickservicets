/** A request rate: `count` requests per window of `windowMs` milliseconds. */
export interface Rate {
  count: number;
  windowMs: number;
}

const RATE_UNITS: Readonly<Record<string, number>> = { s: 1000, min: 60_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RATE = /^\s*([1-9]\d*)\s*\/\s*([1-9]\d*)?(s|min|m|h|d)\s*$/;

/** What a rate looks like, as written in error messages. */
export const RATE_EXPECTATION = "a rate like 100/min";

/** The rate a text like `100/min`, `10/s` or `5/10s` stands for, or undefined when it is not one. */
export function rateOf(text: unknown): Rate | undefined {
  if (typeof text !== "string") return undefined;
  const match = RATE.exec(text);
  if (!match) return undefined;
  const multiplier = match[2] === undefined ? 1 : Number(match[2]);
  return { count: Number(match[1]), windowMs: multiplier * RATE_UNITS[match[3]!]! };
}

/**
 * Parses `<count>/<window>`: a positive count, and a window of `s`, `min`, `m`, `h` or `d`, optionally preceded by a
 * positive integer (`100/min`, `1000/h`, `5/10s`). Throws for any other text.
 */
export function parseRate(text: string): Rate {
  const rate = rateOf(text);
  if (!rate) throw new Error(`Invalid rate ${JSON.stringify(text)}: expected ${RATE_EXPECTATION}`);
  return rate;
}
