# 0088 - The cheaper metrics recording path ships, and the 3% p50 budget on crud stays open until a clean run shows it

- Date: 2026-11-03
- Spec: 0889-metrics-recording-within-its-latency-budget
- Status: accepted

## Context
Spec 0889 asks for a per-request recording path of the `metrics` native that brings `metrics=on` within its 3% p50
budget on `crud` (ADR 0087 measured +3.5%), shown by a new run of the ADR 0085 protocol whose all-off run also passes
the 3% noise budget, without sampling requests or changing the budget or the protocol.

CPU profiles of the benchmark service in its container (`bun --cpu-prof`, `crud`, 64 VUs) put the metrics path at
about 3.6% of the JavaScript thread's samples before the change: the route decision built a `METHOD route` key per
request, the recorder built the route value and the series key strings and hashed them, the observation was built with
object spreads, and each request allocated a pending entry. The latency sketch itself was 0.1%. After the change
(route slots, no per-request strings or keys, no spreads, parallel pending arrays) the same profile puts it at about
2.0%. A recording parity test checks that the series, counts and quantiles are those of a fixture taken before the
change.

`crud` runs of the protocol (req/s and p50 ms, rounds 1, 2, 3; `all off` is every infrastructure native off):

| Session | Run | Round 1 | Round 2 | Round 3 | Best round vs baseline |
| --- | --- | --- | --- | --- | --- |
| a (first half of the change, idle machine) | baseline | 6880, 5.78 | 6958, 5.54 | 6847, 5.71 | |
| | `metrics=on` | 6967, 5.83 | 6769, 5.71 | 6995, 5.82 | +0.5% req/s, +5.1% p50 |
| | all off | 6930, 5.70 | 6773, 5.80 | 6948, 5.70 | -0.1% req/s, +2.9% p50 |
| b (final code, idle machine, stopped in round 3) | baseline | 6859, 5.70 | 6831, 5.61 | 7043, 5.70 | |
| | `metrics=on` | 6911, 5.79 | 6950, 5.81 | 6590, 5.88 | -1.3% req/s, +1.9% p50 |
| | all off | 6501, 5.74 | 6728, 5.69 | - | |
| c (final code, machine in use) | baseline | 5088, 8.54 | 6080, 6.75 | 5798, 6.67 | |
| | `metrics=on` | 5913, 6.92 | 5912, 6.89 | 5610, 7.23 | -2.7% req/s, +2.6% p50 |
| | all off | 5952, 6.80 | 5965, 7.04 | 5877, 6.84 | -1.9% req/s, +4.4% p50 |
| d (final code, machine in use) | baseline | 5083, 7.73 | 5749, 7.08 | 5755, 7.12 | |
| | `metrics=on` | 5132, 7.86 | 5671, 7.43 | 4654, 8.68 | -1.5% req/s, +4.3% p50 |
| | all off | 5357, 8.00 | 5315, 7.45 | 5846, 6.73 | +1.6% req/s, -5.5% p50 |

Round by round on the idle machine, `metrics=on` costs +0.8%, +3.1% and +1.9% p50 in session a, and +1.5%, +3.6% and
+3.1% in session b, against about +3.3% before (ADR 0087). The `crud` p50 lies between the fast reads and writes
(about 4.7 ms) and the slower list and delete (about 7 ms), so small shifts move it by 2 to 3% between identical runs:
the best round's p50 is as noisy as the budget is wide. Sessions c and d ran while the machine was busy with other
applications (load average 15 to 34, throughput 15 to 30% lower and uneven); there the all-off run fails its own noise
budget, so those runs measure the machine, not the native. No session gives a complete run on an idle machine in which
`metrics=on` and the all-off run both pass.

## Options considered
- A: Ship the cheaper recording path, keep the 3% budget and the ADR 0085 protocol, keep the result files of spec 0282
  in `benchmarks/results/features/`, leave the budget criterion of spec 0889 open, and rerun the protocol on an idle
  machine before B11 is marked done.
- B: Commit the results of session c, where `compare-features.ts` passes for `metrics=on`: its all-off run fails the
  noise budget, so that pass is noise.
- C: Sample requests or widen the budget: both are excluded by the spec.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The recording path of `packages/core/src/request-observers.ts`, `http/server.ts` and `features/metrics/` is the cheaper
one, with the parity fixture in `packages/core/src/fixtures/metrics-recording.json`. `benchmarks/results/features/` still holds
the run of spec 0282, so `compare-features.ts` on `metrics-on.json` still exits 1 with
`metrics costs 3.5% on crud; the budget is 3%`. Spec 0889 AC3 (and AC5's ADR 0087 line) stay open, and the B11 and B11a
checkpoints are not marked done, until a run of the ADR 0085 protocol on an idle machine, with this code, has
`metrics=on` within 3% and the all-off run within its noise budget; that run then replaces `baseline.json`,
`metrics-on.json` and the all-off files with their rounds, and ADR 0087 gains the line naming its commit.
