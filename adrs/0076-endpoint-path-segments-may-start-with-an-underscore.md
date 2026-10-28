# 0076 - Endpoint path segments may start with an underscore

- Date: 2026-10-28
- Spec: 0265-metrics-customization-example-and-guide
- Status: accepted

## Context
Spec 0265 R5 says a project endpoint at `GET <path>`, like `endpoints/_metrics/get.ts`, replaces the route of the
`metrics` native, whose default path is `/_metrics`. The endpoint scanner allowed only `a-z`, `0-9`, `-` and `.` in
static path segments, so `endpoints/_metrics` failed the build with `path segments may only contain a-z, 0-9, "-" and
"."`, and the default metrics route could not be replaced by a file at all.

## Options considered
- A: Allow one leading `_` in a static segment (`_metrics`, `_internal`), keeping the rest of the rule; the message
  and the endpoints guide name it — the common convention for system routes, and the smallest change.
- B: Allow `_` anywhere in a segment: widens the URL style of every project for one case.
- C: Keep the rule and document that a project replacing the route must also change `metrics.path`: contradicts the
  spec's example and leaves the default route unreplaceable.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`STATIC_SEGMENT` in the endpoint scanner accepts an optional leading `_`; the build error reads `path segments may only
contain a-z, 0-9, "-" and ".", with an optional leading "_"`, and the endpoints guide says so.
