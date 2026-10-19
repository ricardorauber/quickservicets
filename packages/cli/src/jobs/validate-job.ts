import { assertTimeZone, parseDuration, parseSchedule, ScheduleError, type Schedule } from "@quickservice/core";

/** The reason a `ScheduleError` was thrown; other errors propagate. */
function reasonOf(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof ScheduleError) return error.message;
    throw error;
  }
}

/** Why a job schedule is invalid, or undefined when it is valid. */
export function scheduleError(schedule: unknown): string | undefined {
  return reasonOf(() => parseSchedule(schedule as Schedule));
}

const DURATION_OPTIONS = ["retryDelay", "timeout", "retention"] as const;
const OPTION_NAMES = ["retries", ...DURATION_OPTIONS, "timeZone", "overlap"];

/** Why job options are invalid, or undefined when they are valid. */
export function jobOptionsError(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return "options must be an object";
  const values = options as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!OPTION_NAMES.includes(key)) return `unknown option "${key}" (use ${OPTION_NAMES.join(", ")})`;
  }
  const { retries, timeZone, overlap } = values;
  if (retries !== undefined && (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0)) {
    return `invalid option retries: expected an integer of at least 0, got ${JSON.stringify(retries)}`;
  }
  for (const key of DURATION_OPTIONS) {
    if (values[key] !== undefined && parseDuration(values[key]) === undefined) {
      return `invalid option ${key}: expected a duration like 30s, 10m or 30d, got ${JSON.stringify(values[key])}`;
    }
  }
  if (timeZone !== undefined) {
    const reason = reasonOf(() => assertTimeZone(timeZone as string));
    if (reason) return `invalid option timeZone: ${reason}`;
  }
  if (overlap !== undefined && overlap !== "skip" && overlap !== "parallel") {
    return `invalid option overlap: expected "skip" or "parallel", got ${JSON.stringify(overlap)}`;
  }
  return undefined;
}
