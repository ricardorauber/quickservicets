# 0042 - Endpoint files may be named options.ts

- Date: 2026-10-25
- Spec: 0172-cors
- Status: accepted

## Context
Spec 0172 answers CORS preflights before routing "to a path whose route has no `OPTIONS` endpoint of its own", and its
AC6 checks that "an endpoint file `endpoints/x/options.ts` answers its own preflight". Endpoint files could only be
named `get.ts`, `post.ts`, `put.ts`, `patch.ts` or `delete.ts` (spec 0018), so a project had no way to write that file:
the build rejected it.

## Options considered
- A: Accept `options.ts` as an endpoint file name, routed and documented like the other methods, so a project can answer
  the preflights of one path itself — the smallest change that makes the requirement and its acceptance criterion
  possible.
- B: Keep the five names and let only routes that features register at runtime (`ctx.app.route("OPTIONS", ...)`) answer
  their own preflights: the requirement holds, but the acceptance criterion cannot be checked as written and projects
  cannot use the escape hatch without writing a feature.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`ENDPOINT_METHODS` gains `options`; the build error listing the allowed names, the endpoints guide and the project
structure page name `options.ts`. The security native reads the app's `OPTIONS` routes at setup and lets their
preflights through to them.
