import { describe, expect, test } from "bun:test";
import { assertTimeZone, nextRunTime, parseSchedule, ScheduleError, type Schedule } from "./schedule.ts";

function next(schedule: Schedule, after: string, timeZone?: string): string | null {
  return nextRunTime(schedule, timeZone, new Date(after))?.toISOString() ?? null;
}

/** Successive run times, each computed from the previous one. */
function runs(schedule: Schedule, after: string, count: number, timeZone?: string): string[] {
  const result: string[] = [];
  let reference = new Date(after);
  for (let i = 0; i < count; i++) {
    const run = nextRunTime(schedule, timeZone, reference);
    if (run === null) break;
    result.push(run.toISOString());
    reference = run;
  }
  return result;
}

function reason(schedule: unknown): string {
  try {
    parseSchedule(schedule as Schedule);
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleError);
    return (error as Error).message;
  }
  throw new Error("expected the schedule to be rejected");
}

describe("cron fields", () => {
  test("five fields run on the minute", () => {
    expect(next("*/5 * * * *", "2026-05-10T10:07:12Z")).toBe("2026-05-10T10:10:00.000Z");
    expect(next("0 9 * * *", "2026-05-10T09:00:00Z")).toBe("2026-05-11T09:00:00.000Z");
  });

  test("six fields put the seconds first", () => {
    expect(next("*/5 * * * * *", "2026-05-10T10:00:03Z")).toBe("2026-05-10T10:00:05.000Z");
    expect(next("*/5 * * * * *", "2026-05-10T10:00:05Z")).toBe("2026-05-10T10:00:10.000Z");
    expect(next("*/5 * * * * *", "2026-05-10T10:00:55.500Z")).toBe("2026-05-10T10:01:00.000Z");
    expect(next("0 30 9 * * 1-5", "2026-05-08T09:30:00Z")).toBe("2026-05-11T09:30:00.000Z");
  });

  test("ranges, steps and lists", () => {
    expect(runs("0 8-10 * * *", "2026-05-10T00:00:00Z", 4)).toEqual([
      "2026-05-10T08:00:00.000Z",
      "2026-05-10T09:00:00.000Z",
      "2026-05-10T10:00:00.000Z",
      "2026-05-11T08:00:00.000Z",
    ]);
    expect(runs("0,20,45 * * * *", "2026-05-10T10:00:00Z", 3)).toEqual([
      "2026-05-10T10:20:00.000Z",
      "2026-05-10T10:45:00.000Z",
      "2026-05-10T11:00:00.000Z",
    ]);
    expect(runs("10-30/10 * * * *", "2026-05-10T10:00:00Z", 4)).toEqual([
      "2026-05-10T10:10:00.000Z",
      "2026-05-10T10:20:00.000Z",
      "2026-05-10T10:30:00.000Z",
      "2026-05-10T11:10:00.000Z",
    ]);
    expect(runs("5/20 * * * *", "2026-05-10T10:00:00Z", 4)).toEqual([
      "2026-05-10T10:05:00.000Z",
      "2026-05-10T10:25:00.000Z",
      "2026-05-10T10:45:00.000Z",
      "2026-05-10T11:05:00.000Z",
    ]);
  });

  test("months, days of month and days of week", () => {
    // 2026-05-10 is a Sunday.
    expect(next("0 0 * * 1", "2026-05-10T12:00:00Z")).toBe("2026-05-11T00:00:00.000Z");
    expect(next("0 0 * * 7", "2026-05-11T00:00:00Z")).toBe("2026-05-17T00:00:00.000Z");
    expect(next("0 0 * * SAT", "2026-05-10T00:00:00Z")).toBe("2026-05-16T00:00:00.000Z");
    expect(next("0 0 31 * *", "2026-04-01T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
    expect(next("0 0 1 jan,jul *", "2026-05-10T00:00:00Z")).toBe("2026-07-01T00:00:00.000Z");
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    // Both day fields restricted: either one makes the day due.
    expect(runs("0 0 15 * 1", "2026-05-10T00:00:00Z", 3)).toEqual([
      "2026-05-11T00:00:00.000Z",
      "2026-05-15T00:00:00.000Z",
      "2026-05-18T00:00:00.000Z",
    ]);
  });

  test("presets", () => {
    expect(next("@hourly", "2026-05-10T10:07:12Z")).toBe("2026-05-10T11:00:00.000Z");
    expect(next("@daily", "2026-05-10T10:07:12Z")).toBe("2026-05-11T00:00:00.000Z");
    expect(next("@weekly", "2026-05-10T10:07:12Z")).toBe("2026-05-17T00:00:00.000Z");
    expect(next("@monthly", "2026-05-10T10:07:12Z")).toBe("2026-06-01T00:00:00.000Z");
    expect(next("@yearly", "2026-05-10T10:07:12Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  test("invalid expressions are rejected with a reason", () => {
    expect(reason("61 * * * *")).toBe('invalid cron expression "61 * * * *": minute value 61 is out of range 0-59');
    expect(reason("* * * *")).toContain("expected 5 fields, or 6 with seconds first, but got 4");
    expect(reason("* * * * * * *")).toContain("but got 7");
    expect(reason("0 25 * * *")).toContain("hour value 25 is out of range 0-23");
    expect(reason("0 0 0 * *")).toContain("day of month value 0 is out of range 1-31");
    expect(reason("0 0 * 13 *")).toContain("month value 13 is out of range 1-12");
    expect(reason("0 0 * * 8")).toContain("day of week value 8 is out of range 0-7");
    expect(reason("*/0 * * * *")).toContain('invalid step "0"');
    expect(reason("30-10 * * * *")).toContain("the start is after the end");
    expect(reason("a * * * *")).toContain('invalid minute value "a"');
    expect(reason("1,,2 * * * *")).toContain("empty value");
    expect(reason("0 0 30 2 *")).toContain("never occurs");
    expect(reason("@every")).toContain("unknown preset");
    expect(reason(42)).toContain("invalid schedule");
  });
});

describe("time zones and daylight saving", () => {
  test("cron runs on the wall clock of the time zone", () => {
    expect(next("0 9 * * *", "2026-03-01T13:00:00Z", "America/Sao_Paulo")).toBe("2026-03-02T12:00:00.000Z");
    expect(next("0 9 * * *", "2026-07-01T00:00:00Z", "Asia/Kolkata")).toBe("2026-07-01T03:30:00.000Z");
    expect(next("@daily", "2026-07-01T12:00:00Z", "Europe/Lisbon")).toBe("2026-07-01T23:00:00.000Z");
  });

  test("UTC is the default time zone", () => {
    expect(next("0 9 * * *", "2026-03-01T13:00:00Z")).toBe(next("0 9 * * *", "2026-03-01T13:00:00Z", "UTC"));
    expect(next("0 9 * * *", "2026-03-01T13:00:00Z")).toBe("2026-03-02T09:00:00.000Z");
  });

  test("a wall time skipped by a gap runs at the first instant after the gap", () => {
    // New York springs forward on 2026-03-08 at 02:00 EST -> 03:00 EDT (07:00Z).
    expect(runs("30 2 * * *", "2026-03-07T12:00:00Z", 3, "America/New_York")).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
    // Every wall time in the gap collapses into a single run at 03:00 local.
    expect(runs("*/20 * * * *", "2026-03-08T06:30:00Z", 4, "America/New_York")).toEqual([
      "2026-03-08T06:40:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:20:00.000Z",
      "2026-03-08T07:40:00.000Z",
    ]);
  });

  test("a wall time repeated by an overlap runs once, at its first occurrence", () => {
    // New York falls back on 2026-11-01 at 02:00 EDT -> 01:00 EST (06:00Z).
    expect(runs("30 2 * * *", "2026-10-31T12:00:00Z", 2, "America/New_York")).toEqual([
      "2026-11-01T07:30:00.000Z",
      "2026-11-02T07:30:00.000Z",
    ]);
    expect(runs("30 1 * * *", "2026-10-31T12:00:00Z", 2, "America/New_York")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
    expect(runs("0,30 * * * *", "2026-11-01T05:00:00Z", 4, "America/New_York")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
    // A reference inside the repeated hour does not run the repeated wall times again.
    expect(next("*/10 * * * * *", "2026-11-01T06:10:00Z", "America/New_York")).toBe("2026-11-01T07:00:00.000Z");
  });

  test("southern-hemisphere and half-hour transitions", () => {
    // Sydney springs forward on 2026-10-04 at 02:00 AEST -> 03:00 AEDT (2026-10-03T16:00Z).
    expect(next("30 2 * * *", "2026-10-03T12:00:00Z", "Australia/Sydney")).toBe("2026-10-03T16:00:00.000Z");
    // Lord Howe moves by 30 minutes, from 02:00 to 02:30 local (2026-10-03T15:30Z).
    expect(next("15 2 * * *", "2026-10-03T12:00:00Z", "Australia/Lord_Howe")).toBe("2026-10-03T15:30:00.000Z");
  });

  test("unknown time zones are rejected with a reason", () => {
    expect(() => nextRunTime("@daily", "Mars/Base", new Date())).toThrow(
      'unknown time zone "Mars/Base" (expected an IANA time zone such as "Europe/Lisbon")',
    );
    expect(() => assertTimeZone("Mars/Base")).toThrow(ScheduleError);
    expect(() => assertTimeZone("America/Sao_Paulo")).not.toThrow();
  });

  test("the result depends only on its inputs", () => {
    const after = new Date("2026-03-08T06:59:59.999Z");
    const first = nextRunTime("30 2 * * *", "America/New_York", after);
    const second = nextRunTime(parseSchedule("30 2 * * *"), "America/New_York", after);
    expect(first).toEqual(second);
    expect(after.toISOString()).toBe("2026-03-08T06:59:59.999Z");
  });
});

describe("intervals", () => {
  test("runs are aligned to multiples of the interval since the epoch", () => {
    expect(next({ every: "15m" }, "2026-05-10T10:07:12Z")).toBe("2026-05-10T10:15:00.000Z");
    expect(next({ every: "10s" }, "2026-05-10T10:00:03Z")).toBe("2026-05-10T10:00:10.000Z");
    expect(next({ every: "1s" }, "2026-05-10T10:00:03.250Z")).toBe("2026-05-10T10:00:04.000Z");
    expect(next({ every: "2h" }, "2026-05-10T11:30:00Z")).toBe("2026-05-10T12:00:00.000Z");
    expect(next({ every: "1d" }, "2026-05-10T11:30:00Z")).toBe("2026-05-11T00:00:00.000Z");
    expect(next({ every: "7m" }, "1970-01-01T00:20:00Z")).toBe("1970-01-01T00:21:00.000Z");
  });

  test("a reference on a boundary gives the following one", () => {
    expect(runs({ every: "15m" }, "2026-05-10T10:15:00Z", 3)).toEqual([
      "2026-05-10T10:30:00.000Z",
      "2026-05-10T10:45:00.000Z",
      "2026-05-10T11:00:00.000Z",
    ]);
  });

  test("intervals ignore the time zone", () => {
    expect(next({ every: "15m" }, "2026-05-10T10:07:12Z", "Asia/Kolkata")).toBe("2026-05-10T10:15:00.000Z");
  });

  test("invalid intervals are rejected with a reason", () => {
    expect(reason({ every: "500ms" })).toBe('invalid interval "500ms": unknown unit "ms" (expected s, m, h or d)');
    expect(reason({ every: "5w" })).toContain('unknown unit "w"');
    expect(reason({ every: "0s" })).toContain("the minimum is 1s");
    expect(reason({ every: "1.5h" })).toContain("whole number");
    expect(reason({ every: "m" })).toContain("whole number");
    expect(reason({ every: 15 })).toContain('"every" must be a string');
  });
});

describe("single dates", () => {
  const at = { at: "2026-01-01T00:00:00Z" };

  test("before the instant, the next run is that instant", () => {
    expect(next(at, "2025-12-31T23:59:59Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(next({ at: "2026-12-01T09:00:00-03:00" }, "2026-01-01T00:00:00Z")).toBe("2026-12-01T12:00:00.000Z");
    expect(next({ at: "2026-12-01T09:00:00.250+05:30" }, "2026-01-01T00:00:00Z")).toBe("2026-12-01T03:30:00.250Z");
  });

  test("at or after the instant, there is no next run", () => {
    expect(next(at, "2026-01-01T00:00:00Z")).toBeNull();
    expect(next(at, "2026-06-01T00:00:00Z")).toBeNull();
  });

  test("invalid dates are rejected with a reason", () => {
    expect(reason({ at: "tomorrow" })).toBe(
      'invalid date "tomorrow": expected an ISO 8601 date-time with an offset, such as "2026-12-01T09:00:00Z"',
    );
    expect(reason({ at: "2026-02-30T00:00:00Z" })).toContain("does not exist");
    expect(reason({ at: "2026-01-01T24:00:00Z" })).toContain("does not exist");
    expect(reason({ at: "2026-01-01T09:00:00" })).toContain("with an offset");
    expect(reason({ at: "2026-01-01" })).toContain("with an offset");
    expect(reason({ at: 1 })).toContain('"at" must be an ISO 8601 date-time string');
    expect(reason({ at: "2026-01-01T00:00:00Z", every: "1m" })).toContain("invalid schedule");
  });
});
