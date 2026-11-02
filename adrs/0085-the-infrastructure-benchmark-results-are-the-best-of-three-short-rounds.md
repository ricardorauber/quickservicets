# 0085 - The infrastructure benchmark results are the best of three short rounds of crud and health

- Date: 2026-11-02
- Spec: 0282-infrastructure-natives-benchmark-runs
- Status: accepted

## Context
Spec 0282 asks the repository to keep the result files of one full run of the infrastructure switches, compared with
the baseline under budgets of 3% (10% for tenancy) on `crud`. A full run of every scenario with the default 30-second
measurements takes about eight minutes per switch, and on the benchmark machine a single short run of `crud` varies by
3 to 4% between identical images, so one round can fail a 3% budget on noise alone.

## Options considered
- A: Run `crud` (the budgeted scenario) and `health` (the framework's floor) for 15 seconds after a 5-second warmup,
  in three rounds (the second in reverse order), keep every round and use, for each switch and scenario, the round
  with the most requests per second, as the stack results of the README already do ("the better of two full rounds
  per stack and scenario").
- B: One round of every scenario at the defaults: about an hour, and still exposed to the same noise.
- C: Widen the budgets: weakens what the spec measures.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`results/features/round-1/` to `round-3/` hold every round; each file of `results/features/` (and its `baseline.json`)
holds the best round of each scenario of its switch, and the benchmarks README says how the run was made.
