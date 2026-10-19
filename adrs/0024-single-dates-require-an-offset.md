# 0024 - Single-date schedules require an explicit UTC offset

- Date: 2026-10-19
- Spec: 0104-job-schedule-evaluation
- Status: accepted

## Context
Spec 0104 R4 makes `{ at }` due "once at that instant", and 0103 R2 accepts "an ISO 8601 date-time". ISO 8601 also
allows a local date-time without an offset (`2026-12-01T09:00:00`). `Date.parse` reads such a value in the machine's
own time zone, so instances in different zones would compute different run times, breaking R1. Neither spec says how a
date-time without an offset is read.

## Options considered
- A: Require a `Z` or `±HH:MM` offset and reject anything else with a descriptive reason — the value is always an
  absolute instant, parsing needs no time zone, and the result is the same on every instance.
- B: Read a date-time without an offset in the job's `timeZone` — friendlier to write, but parsing then depends on
  the time zone and a local time can fall in a daylight saving gap or overlap.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`parseDate` rejects `{ at: "2026-12-01T09:00:00" }` with `expected an ISO 8601 date-time with an offset`. The build
validation of spec 0103 reports that reason. Specs 0103 and 0104 could state "with an offset" explicitly in an
`update-spec`.
