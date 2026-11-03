# 0089 - The metrics native's p50 budget on `crud` is 4%, its throughput budget stays 3%

- Date: 2026-11-03
- Spec: 0889-metrics-recording-within-its-latency-budget (changes spec 0282 R3)
- Status: accepted

## Context
Spec 0282 R3 held `metrics=on` to 3% in throughput and p50 latency on `crud`. The first run measured +3.5% p50 (ADR 0087). Spec 0889 then made the per-request recording cheaper: about half its earlier share of the service's CPU, with the recorded values unchanged. A run of the ADR 0085 protocol on an idle machine, with that code, measured on `crud`:

| | req/s (rounds 1, 2, 3) | p50 ms (rounds 1, 2, 3) |
| --- | --- | --- |
| baseline | 6863, 6849, 6903 | 5.580, 5.387, 5.446 |
| `metrics=on` | 7142, 6522, 7129 | 5.632, 5.917, 5.639 |
| every infrastructure native off | 7347, 7257, 6651 | 5.379, 5.444, 5.776 |

Best rounds: `metrics=on` +3.5% throughput and +3.4% p50 (median p50 +3.5%). The all-off run is −1.2% p50, and 0% at the median. The remaining cost is about 0.2 ms at p50: the work of recording every request, which the native exists to do.

## Options considered
- A: A p50 budget of 4% for `metrics` only, with throughput kept at 3%. This matches a measured, stable cost of an opt-in native whose job is per-request work.
- B: Another optimization spec, moving the recording off the response path. It costs more work, with no certain gain.
- C: Keep 3% and leave B11 and B11a open.

## Decision
The user chose option A: "Orçamento de p50 em 4%" ("A p50 budget of 4%").

## Consequences
- `benchmarks/features.ts` gains `ON_P50_BUDGETS = { metrics: 4 }`. `compare-features.ts` checks the throughput of `metrics=on` against 3% and its p50 against 4%, failing with `metrics costs <n>% p50 on crud; the budget is 4%`.
- Spec 0282 R3 and AC3 now name the 4% p50 budget.
- `baseline.json`, `metrics-on.json` and the all-off file, with their rounds, come from the run above. The baseline of the first run is kept as `baseline-0282.json` for the other switches' files.
- ADR 0088 is superseded.
