# Evaluation

## Controlled-DAG benchmark (design §14 M4)

**Task family** (`evals/controlled-dag/tasks.ts`). Seeded arithmetic dependency graphs: 2–3 leaf values, then
`depth ∈ [1, 6]` derived nodes, each combining two earlier nodes with `+ − ×`. The answer is computed exactly, so
every outcome is scored by the `exact-answer` verifier, never an LLM judge. 40 % of tasks are marked as having
independent sub-computations (low coupling → parallel allowed); the rest can still be delegated whole.

**Executors** (`evals/controlled-dag/sim-executor.ts`). `P(correct) = base · decay^depth`; wrong answers are off by 1–9.

| Executor | base | decay | cost | latency | infra failures | self-report |
|---|---|---|---|---|---|---|
| `dsh-local` | 0.92 | 0.80 | $0.002 | 3 s | 2 % | calibrated |
| `peer-specialist` | 0.98 | 0.97 | $0.020 | 8 s | 3 % | calibrated |
| `peer-overconfident` | 0.70 | 0.85 | $0.004 | 2 s | 2 % | always 0.95 |
| `peer-slow` | 0.95 | 0.94 | $0.010 | 25 s | 10 % | calibrated |

Latency is sampled in `[0.6, 1.4] ×` nominal, and every run happens in **virtual time** (`FakeClock`), so results
are deterministic per seed.

**Protocol.** Each strategy starts with no history and processes the same 300-task stream in order, learning
executor reliability online from its own verified outcomes. The budget per task is identical: $0.06, ≤ 3 remote
calls, ≤ 3 parallel attempts, 90 s deadline. All strategies share the same hard limits, safety gates and
verification step (baselines reuse the DVO candidate generator). Success means the final answer was verified.

```bash
npm run eval:dag -- --tasks 300 --seed 7     # also 13, 21; add --scenario overconfident-local
```

### Results (3 seeds × 300 tasks; range across seeds in brackets)

| Strategy | Verified success | Mean cost | p95 latency | Remote calls |
|---|---|---|---|---|
| Single agent (local only) | 66.4 % [59.3–70.0] | $0.0031 | 7.4 s | 0.00 |
| Fixed topology (fan out to all peers) | 95.3 % [94.0–96.0] | $0.0258 | 15.8 s | 1.77 |
| Confidence-gated (τ = 0.8) | **99.6 %** [99.3–99.7] | **$0.0151** | 38.2 s | 0.71 |
| DVO (value $1 per success) | 99.2 % [99.0–99.3] | $0.0259 | **23.5 s** | 1.77 |
| DVO (value $0.10 per success) | 66.4 % [59.3–70.0] | $0.0031 | 7.4 s | 0.00 |
| DVO + ε = 0.1 exploration ($0.10) | 98.3 % [97.7–98.7] | $0.0180 | 34.1 s | 1.02 |

Success by task depth (seed 7):

| Strategy | d=1 | d=2 | d=3 | d=4 | d=5 | d=6 |
|---|---|---|---|---|---|---|
| Single agent | 97 % | 83 % | 76 % | 59 % | 51 % | 44 % |
| Fixed topology | 100 % | 98 % | 96 % | 98 % | 89 % | 91 % |
| Confidence-gated | 100 % | 100 % | 98 % | 100 % | 100 % | 97 % |
| DVO ($1) | 100 % | 100 % | 100 % | 97 % | 100 % | 97 % |
| DVO + exploration ($0.10) | 100 % | 98 % | 100 % | 98 % | 98 % | 97 % |

## Reading the results

1. **Verification dominates.** With a deterministic verifier in the loop, "verify, then escalate on refutation" is
   what separates 66 % from 99 %. Confidence-gating shares DVO's verification step and is the cheapest near-perfect
   strategy on this family.
2. **DVO trades cost for tail latency.** On decomposable tasks it hedges with parallel peers and verifies the first
   answer that arrives (cancelling the rest), cutting p95 latency by ~40 % relative to confidence-gating at ~1.7× the
   mean cost. Under a success/cost/p95 Pareto criterion no strategy dominates another; which one to prefer is a
   question of the value of latency, which DVO makes an explicit parameter.
3. **The LCB gate is conservative, and cold-start is real.** With a low value per success ($0.10), the lower bound
   on unproven peers never clears their cost, so DVO never tries them and never learns that the specialist is
   excellent. This is the conservative behaviour design §7.1 asks for, and also why §7.2 prescribes controlled
   exploration. With ε = 0.1 on safe tasks the same configuration reaches 98.3 %, for ~70 % of the cost of DVO at $1 per
   success ($0.0180 vs $0.0259), while logging propensities for off-policy evaluation.
4. **Miscalibrated self-reports do not matter here.** Making the local model always report 0.95
   (`--scenario overconfident-local`) produces bit-identical results for every strategy: with verification in the
   loop, self-reported confidence never drives a decision. The overconfident *peer* is similarly neutralised: it is
   tried, refuted, and its reliability estimate falls.
5. **What a bug looked like.** An earlier version mapped "sub-tasks are not independent" to a coupling above the
   *delegation* threshold, which blocked every peer on 60 % of tasks (DVO stuck at local-only quality). The persisted
   block reasons (`not_decomposable` on every delegate candidate) made the cause visible in one trace. The mapping
   now distinguishes "not parallelisable" from "not delegable" ([policy.md](policy.md#coupling-semantics)).

## Threats to validity

* **Simulated executors** with independent errors. Real models' errors are correlated across retries and between
  models trained on similar data; the retry-correlation discount (ρ = 0.5) is a stand-in, not a measurement.
* **One task family**, with an exact verifier always available. Unverifiable tasks, where the value model falls back
  to selection by calibrated confidence (`v = 0`), are not evaluated here.
* **Short horizon** (300 tasks) from a cold start: the ranking of peers is still being learned during the run.
* **Costs and latencies are nominal**, not measured from providers.

## Planned task families

`evals/tool-use` and `evals/code-repair` are specified (see their READMEs) but not implemented. Code repair will use
the `command` verifier (unit tests in an isolated directory) as its deterministic check.
