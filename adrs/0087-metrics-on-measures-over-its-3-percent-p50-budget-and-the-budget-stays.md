# 0087 - metrics=on measures over its 3% p50 budget on crud, and the budget stays

- Date: 2026-11-02
- Spec: 0282-infrastructure-natives-benchmark-runs
- Status: accepted

## Context
Spec 0282 R3 holds `metrics=on` to at most 3% throughput and p50 latency on `crud`. The run committed in
`benchmarks/results/features/` (three rounds of `crud` and `health`, 15 seconds after a 5-second warmup, ADR 0085,
after batching the request observers' microtasks and building series keys without a dimensions object per request)
measured, on `crud`:

| | req/s (rounds 1, 2, 3) | p50 ms (rounds 1, 2, 3) |
| --- | --- | --- |
| baseline | 6870, 6758, 6728 | 5.69, 5.59, 5.70 |
| `metrics=on` | 6895, 6775, 6883 | 5.88, 5.95, 5.84 |

The best rounds give +0.4% throughput and +3.5% p50 (median p50 +3.3%); the switches that do nothing on the request
path (`proxy`, `secrets`, `realtime`, all off) stay within 5.59 to 5.78 ms, so the p50 cost is real and about half a
point over the budget. Throughput is within it. Every other budget holds.

## Options considered
- A: Keep the 3% budget, commit the measured results with `compare-features.ts` failing on `metrics=on`, and leave the
  block checkpoint's "the infrastructure budgets hold" open until the metrics native's per-request recording is made
  cheaper.
- B: Raise the metrics budget to 4%: hides a measured cost behind a looser rule.
- C: Keep optimizing inside spec 0282: work on the metrics native that no requirement of this spec describes.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`bun benchmarks/compare-features.ts benchmarks/results/features/metrics-on.json --baseline
benchmarks/results/features/baseline.json` exits 1 with `metrics costs 3.5% on crud; the budget is 3%`. The B11
checkpoint is not marked done while this budget fails; the metrics recording path (one observation per request
through `notifyRequestObservers`, the window lookup and the latency sketch) needs a follow-up spec or fix before it is.
