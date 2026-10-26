# 0061 - Benchmark analysis records keep the old `all()` name

- Date: 2026-10-26
- Spec: 0826-query-toarray-and-boolean-all
- Status: accepted

## Context
Spec 0826 R7 changes every use of the record-returning `all()` in packages, examples, benchmarks and docs to
`toArray()`, and AC6 checks that a search of those folders finds none. Under `benchmarks/`, the only mentions are in
`benchmarks/analysis/quickservicets-profile.md` and `benchmarks/analysis/whatif/core.diff`: a dated profiling report and
the patch its what-if experiments applied to a copy of `packages/core/src` as it was on 2026-10-19. Neither calls the
query API; they describe the code of that day, and the patch only applies to that snapshot.

## Options considered
- A: Leave the dated analysis records as they are and change every current use (code, tests, examples, benchmark
  services, docs) — the records stay true to the code they measured; the AC6 search covers everything except these
  historical records.
- B: Rename `all()` and `findAllMax` inside the report and the patch too — a literal AC6 search finds nothing, but the
  report then names an API that did not exist when it was written, and the patch no longer matches the snapshot it
  documents.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`benchmarks/analysis/` keeps its 2026-10-19 wording. AC6 is verified with a search of packages, examples, benchmarks
and docs that excludes `benchmarks/analysis/`; every other record-returning `all()` is now `toArray()`.
