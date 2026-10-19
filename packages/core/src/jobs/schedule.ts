/**
 * Job schedules: parsing and next-run computation.
 *
 * Everything here is pure: the next run time depends only on the schedule, the time zone and the
 * reference instant, so every instance of a service computes the same run times.
 */

/** A schedule as written in a job declaration. */
export type Schedule = string | { every: string } | { at: string };

export interface CronSchedule {
  kind: "cron";
  /** The expression as written (a preset keeps its name). */
  source: string;
  seconds: ReadonlySet<number>;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday ... 6 = Saturday (7 is accepted on input as Sunday). */
  daysOfWeek: ReadonlySet<number>;
  /** Whether the day-of-month field was written starting with `*`. */
  anyDayOfMonth: boolean;
  /** Whether the day-of-week field was written starting with `*`. */
  anyDayOfWeek: boolean;
}

export interface IntervalSchedule {
  kind: "every";
  source: string;
  milliseconds: number;
}

export interface DateSchedule {
  kind: "at";
  source: string;
  instant: Date;
}

export type ParsedSchedule = CronSchedule | IntervalSchedule | DateSchedule;

/** Thrown for an invalid schedule or time zone; the message is the reason, ready to show to a user. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export const DEFAULT_TIME_ZONE = "UTC";

const PRESETS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const SECOND: FieldSpec = { name: "second", min: 0, max: 59 };
const MINUTE: FieldSpec = { name: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: "day of month", min: 1, max: 31 };
const MONTH: FieldSpec = {
  name: "month",
  min: 1,
  max: 12,
  names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
};
const DAY_OF_WEEK: FieldSpec = {
  name: "day of week",
  min: 0,
  max: 7,
  names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

const UNIT_MILLISECONDS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses any schedule form, throwing a `ScheduleError` with a descriptive reason when it is invalid. */
export function parseSchedule(schedule: Schedule): ParsedSchedule {
  if (typeof schedule === "string") return parseCron(schedule);
  if (schedule !== null && typeof schedule === "object") {
    const keys = Object.keys(schedule);
    if (keys.length === 1 && keys[0] === "every") return parseInterval((schedule as { every: unknown }).every);
    if (keys.length === 1 && keys[0] === "at") return parseDate((schedule as { at: unknown }).at);
  }
  throw new ScheduleError(
    'invalid schedule: expected a cron string, { every: "<n><unit>" } or { at: "<ISO 8601 date-time>" }',
  );
}

/** Parses a cron expression (5 fields, or 6 with seconds first) or a preset such as `@daily`. */
export function parseCron(expression: string): CronSchedule {
  const source = expression.trim();
  if (source.startsWith("@")) {
    const preset = PRESETS[source];
    if (preset === undefined) {
      throw new ScheduleError(
        `invalid cron expression "${expression}": unknown preset (expected one of ${Object.keys(PRESETS).join(", ")})`,
      );
    }
    return { ...parseCronFields(preset, preset), source };
  }
  return { ...parseCronFields(source, expression), source };
}

function parseCronFields(source: string, written: string): CronSchedule {
  const fields = source.split(/\s+/).filter((field) => field !== "");
  if (fields.length !== 5 && fields.length !== 6) {
    throw new ScheduleError(
      `invalid cron expression "${written}": expected 5 fields, or 6 with seconds first, but got ${fields.length}`,
    );
  }
  const withSeconds = fields.length === 6 ? fields : ["0", ...fields];
  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = withSeconds as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const fail = (reason: string): never => {
    throw new ScheduleError(`invalid cron expression "${written}": ${reason}`);
  };
  const daysOfWeek = new Set([...parseField(dayOfWeek, DAY_OF_WEEK, fail)].map((day) => day % 7));
  const parsed: CronSchedule = {
    kind: "cron",
    source: written,
    seconds: parseField(second, SECOND, fail),
    minutes: parseField(minute, MINUTE, fail),
    hours: parseField(hour, HOUR, fail),
    daysOfMonth: parseField(dayOfMonth, DAY_OF_MONTH, fail),
    months: parseField(month, MONTH, fail),
    daysOfWeek,
    anyDayOfMonth: dayOfMonth.startsWith("*"),
    anyDayOfWeek: dayOfWeek.startsWith("*"),
  };
  if (!parsed.anyDayOfMonth && parsed.anyDayOfWeek && !anyDayExists(parsed)) {
    fail("the day of month never occurs in the selected months");
  }
  return parsed;
}

function anyDayExists(cron: CronSchedule): boolean {
  // February counts its leap day, so `29 2` is a valid (if rare) schedule.
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const month of cron.months) {
    for (const day of cron.daysOfMonth) if (day <= (longest[month - 1] ?? 0)) return true;
  }
  return false;
}

function parseField(text: string, spec: FieldSpec, fail: (reason: string) => never): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") fail(`empty value in the ${spec.name} field "${text}"`);
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "") fail(`invalid ${spec.name} "${item}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        fail(`invalid step "${stepText}" in the ${spec.name} field (expected a positive integer)`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = spec.min;
      end = spec === DAY_OF_WEEK ? 6 : spec.max;
    } else if (range!.includes("-")) {
      const [from, to, more] = range!.split("-");
      if (more !== undefined || from === undefined || to === undefined) fail(`invalid ${spec.name} range "${range}"`);
      start = parseValue(from!, spec, fail);
      end = parseValue(to!, spec, fail);
      if (start > end) fail(`invalid ${spec.name} range "${range}": the start is after the end`);
    } else {
      start = parseValue(range!, spec, fail);
      // `5/15` means "from 5 to the end of the range, every 15".
      end = stepText === undefined ? start : spec.max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseValue(text: string, spec: FieldSpec, fail: (reason: string) => never): number {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + (spec === MONTH ? 1 : 0);
  if (!/^\d+$/.test(text)) fail(`invalid ${spec.name} value "${text}"`);
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    fail(`${spec.name} value ${value} is out of range ${spec.min}-${spec.max}`);
  }
  return value;
}

/** Parses an interval such as `"15m"`: a positive integer followed by `s`, `m`, `h` or `d`. */
export function parseInterval(every: unknown): IntervalSchedule {
  if (typeof every !== "string") {
    throw new ScheduleError('invalid interval: "every" must be a string such as "15m"');
  }
  const match = /^(\d+)([a-z]*)$/i.exec(every.trim());
  if (match === null) {
    throw new ScheduleError(`invalid interval "${every}": expected "<n><unit>" with a whole number, such as "15m"`);
  }
  const [, amount, unit] = match as unknown as [string, string, string];
  const unitMilliseconds = UNIT_MILLISECONDS[unit];
  if (unitMilliseconds === undefined) {
    throw new ScheduleError(`invalid interval "${every}": unknown unit "${unit}" (expected s, m, h or d)`);
  }
  const milliseconds = Number(amount) * unitMilliseconds;
  if (milliseconds < 1_000) throw new ScheduleError(`invalid interval "${every}": the minimum is 1s`);
  return { kind: "every", source: every, milliseconds };
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Parses a single date: an ISO 8601 date-time with a `Z` or `±HH:MM` offset. */
export function parseDate(at: unknown): DateSchedule {
  if (typeof at !== "string") {
    throw new ScheduleError('invalid date: "at" must be an ISO 8601 date-time string such as "2026-12-01T09:00:00Z"');
  }
  const invalid = (reason: string): never => {
    throw new ScheduleError(`invalid date "${at}": ${reason}`);
  };
  const match = ISO_DATE_TIME.exec(at.trim());
  if (match === null) {
    return invalid('expected an ISO 8601 date-time with an offset, such as "2026-12-01T09:00:00Z"');
  }
  const [, year, month, day, hour, minute, second = "0", fraction = "", offset] = match as unknown as string[];
  const parts = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
  const [y, mo, d, h, mi, s] = parts;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, Number(fraction.padEnd(3, "0").slice(0, 3)));
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  ) {
    invalid("the date or time does not exist");
  }
  let offsetMilliseconds = 0;
  if (offset !== undefined && offset.toUpperCase() !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) invalid(`invalid offset "${offset}"`);
    offsetMilliseconds = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  return { kind: "at", source: at, instant: new Date(wall - offsetMilliseconds) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new ScheduleError(`unknown time zone "${timeZone}" (expected an IANA time zone such as "Europe/Lisbon")`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws a `ScheduleError` unless `timeZone` is an IANA time zone known to the runtime. */
export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone === "") {
    throw new ScheduleError("unknown time zone: expected an IANA time zone name");
  }
  formatterFor(timeZone);
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The next run time strictly after `after`, or `null` when the schedule never runs again.
 *
 * Cron schedules are evaluated in `timeZone` (default `UTC`). A wall time skipped by a daylight saving
 * gap runs at the first instant after the gap; a wall time repeated by an overlap runs once, at its
 * first occurrence. Intervals are aligned to multiples of the interval since the Unix epoch. A single
 * date is returned only while it is still ahead of `after`. Missed run times are never returned.
 */
export function nextRunTime(
  schedule: Schedule | ParsedSchedule,
  timeZone: string | undefined,
  after: Date,
): Date | null {
  const parsed = isParsed(schedule) ? schedule : parseSchedule(schedule);
  const reference = after.getTime();
  if (Number.isNaN(reference)) throw new ScheduleError("invalid reference date");
  switch (parsed.kind) {
    case "every":
      return new Date((Math.floor(reference / parsed.milliseconds) + 1) * parsed.milliseconds);
    case "at":
      return parsed.instant.getTime() > reference ? new Date(parsed.instant.getTime()) : null;
    case "cron":
      return nextCronTime(parsed, timeZone ?? DEFAULT_TIME_ZONE, reference);
  }
}

function isParsed(schedule: Schedule | ParsedSchedule): schedule is ParsedSchedule {
  return typeof schedule === "object" && schedule !== null && "kind" in schedule;
}

function nextCronTime(cron: CronSchedule, timeZone: string, reference: number): Date | null {
  const formatter = formatterFor(timeZone);
  const offsetAt = (instant: number): number => offsetOf(formatter, instant);
  // Wall times are kept as "naive" milliseconds: the local date and time read as if it were UTC.
  const referenceWall = Math.floor(reference / SECOND_MS) * SECOND_MS + offsetAt(reference);
  let start = Math.floor(referenceWall / SECOND_MS) * SECOND_MS + SECOND_MS;
  const lastYear = new Date(start).getUTCFullYear() + 400;
  for (;;) {
    const wall = nextMatchingWall(cron, start, lastYear);
    if (wall === null) return null;
    const resolved = resolveWall(wall, offsetAt);
    if (resolved.instant > reference) return new Date(resolved.instant);
    start = Math.max(wall + SECOND_MS, resolved.resumeAt ?? 0);
  }
}

function offsetOf(formatter: Intl.DateTimeFormat, instant: number): number {
  const whole = Math.floor(instant / SECOND_MS) * SECOND_MS;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(whole)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wall - whole;
}

interface ResolvedWall {
  instant: number;
  /** For a repeated wall time: the first wall time after the overlap, where a search can resume. */
  resumeAt?: number;
}

/** Maps a wall time to the instant it runs at, applying the daylight saving rules. */
function resolveWall(wall: number, offsetAt: (instant: number) => number): ResolvedWall {
  const offsets = new Set([offsetAt(wall - DAY_MS), offsetAt(wall), offsetAt(wall + DAY_MS)]);
  const instants = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => instant + offsetAt(instant) === wall)
    .sort((a, b) => a - b);
  const first = instants[0];
  if (first !== undefined) {
    const last = instants[instants.length - 1]!;
    if (last === first) return { instant: first };
    // Overlap: the wall time happens twice; it runs at the first occurrence.
    const transition = findTransition(first, last, offsetAt);
    return { instant: first, resumeAt: transition + offsetAt(first) };
  }
  // Gap: the wall time does not exist; it runs at the first instant after the gap.
  const before = offsetAt(wall - DAY_MS);
  const afterGap = offsetAt(wall + DAY_MS);
  if (before === afterGap) return { instant: wall - before };
  return { instant: findTransition(wall - afterGap, wall - before, offsetAt) };
}

/** The first whole second in `(low, high]` whose offset equals the offset at `high`. */
function findTransition(low: number, high: number, offsetAt: (instant: number) => number): number {
  const target = offsetAt(high);
  let lo = Math.floor(low / SECOND_MS);
  let hi = Math.ceil(high / SECOND_MS);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid * SECOND_MS) === target) hi = mid;
    else lo = mid;
  }
  return hi * SECOND_MS;
}

/** The first wall time at or after `start` that matches every cron field. */
function nextMatchingWall(cron: CronSchedule, start: number, lastYear: number): number | null {
  let wall = start;
  for (;;) {
    const date = new Date(wall);
    const year = date.getUTCFullYear();
    if (year > lastYear) return null;
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    if (!cron.months.has(month + 1)) {
      wall = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!dayMatches(cron, day, date.getUTCDay())) {
      wall = Date.UTC(year, month, day + 1);
      continue;
    }
    if (!cron.hours.has(date.getUTCHours())) {
      wall = Math.floor(wall / HOUR_MS) * HOUR_MS + HOUR_MS;
      continue;
    }
    if (!cron.minutes.has(date.getUTCMinutes())) {
      wall = Math.floor(wall / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
      continue;
    }
    if (!cron.seconds.has(date.getUTCSeconds())) {
      wall += SECOND_MS;
      continue;
    }
    return wall;
  }
}

function dayMatches(cron: CronSchedule, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonth = cron.daysOfMonth.has(dayOfMonth);
  const byWeek = cron.daysOfWeek.has(dayOfWeek);
  // Classic cron: when both day fields are restricted, a day matching either one is due.
  if (!cron.anyDayOfMonth && !cron.anyDayOfWeek) return byMonth || byWeek;
  return byMonth && byWeek;
}
