# The Delegation Value Orchestrator policy

`DvoRulePolicy` (`packages/policy/src/rule-policy.ts`) implements design §7.1 and appendix C: rules first, then
calibrated value gating. It is a pure function of `PolicyInput`, which is persisted with every decision, so every
decision can be replayed exactly (`harness replay <taskId>`).

## Order of precedence

Each step can only restrict what later steps may do:

1. **Hard limits.** Deadline reached → `stop(deadline)`. Committed spend plus reservations exhausts the budget
   → `stop(budget)`.
2. **A verified answer exists** → `stop(sufficient_evidence)`.
3. **Unverified answers and a deterministic verifier is available** → `verify`.
4. **Value gating.** Every candidate is scored; escalations must pass the LCB gate (below). If nothing has
   been produced yet, `continue_local` is the default.
5. **Nothing worth doing** → `stop(sufficient_evidence)` if an answer exists, else a stop whose reason is
   derived from the block reasons (deadline, budget or unsafe).

## Value model

Let `SV` be the task's utility of a correct answer (`successValueUsd`, default $1), and `qᵢ` the probability
that candidate answer *i* is correct: its calibrated confidence, 1 if verified, excluded if refuted. The
success probability of the current state is

```text
P(q, v) = v · (1 − ∏(1 − qᵢ)) + (1 − v) · maxᵢ qᵢ
```

where `v = 1` when a deterministic verifier can run (any correct candidate can be identified) and `v = 0`
otherwise (the answer is picked by confidence). V1 deliberately ignores majority-vote aggregation.

A candidate action adds new independent answers with probabilities `pⱼ`:

| Action | Added answers | Cost | Latency |
|---|---|---|---|
| `continue_local` | local reliability × depth discount × retry correlation | local estimate | local p95 |
| `delegate(p)` | peer reliability × depth discount × retry correlation | peer estimate | peer p95 |
| `parallel(P)` | one per peer (top-k by LCB, k ≤ width, parallel slots and remote calls) | Σ | max |
| `request_evidence(a)` | improves separability of conflicting answers × informativeness | peer | peer |
| `verify` | turns `v=0` selection into `v=1` identification | ≈ 0 | verifier |

* **Reliability** is a Beta posterior over the executor's observed outcomes (prior local Beta(3,2), peer
  Beta(1,1)). Success means *verified correct*. Refuted, failed, timed-out, invalid and refused outcomes count as
  failures; cancellations are neutral. Skill-specific statistics are used once they have ≥ 3 observations.
* **Depth discount** `q · (1 − depthPenalty · reasoningDepth)` applies to every executor alike. It changes
  absolute values, never the ranking between executors, so reasoning depth alone can never add agents (design §5.3).
* **Retry correlation.** Asking the same executor again after it already answered is correlated with that answer:
  `q · (1 − ρ)^k` for `k` prior answers (ρ = 0.5).

For each candidate the policy computes

```text
gain       = SV · (P(q ∪ p_mean, v) − P(q, v))
lcb        = SV · (P(q ∪ p_lcb,  v) − P(q, v))        p_lcb: Wilson lower bound (90 %, one-sided)
risk       = SV · (trustPenalty[tier] + halfOpenPenalty·[circuit half-open])
netValue   = lcb − cost − latencyCostUsdPerSecond · latency − risk
```

**Gate:** an escalation (`delegate`, `parallel`, `request_evidence`) is eligible only if
`netValue > minNetValueUsd` **and** `lcb > cost + risk`, the rule of appendix C. The best eligible candidate by
net value wins. Ties go to the cheaper, less exposed action, and ordering is fully deterministic.

Without a verifier the policy stops once the best calibrated confidence reaches `sufficientConfidence` (0.9).

## Block reasons

Every candidate that is not selected carries the reasons it was ineligible. They are persisted and exported:

| Reason | Meaning |
|---|---|
| `deadline_window`, `latency_exceeds_deadline` | too little time for an escalation / for this executor |
| `budget_cost`, `budget_remote_calls`, `budget_tokens`, `max_parallel` | would exceed a hard budget (reservations included) |
| `remote_disallowed`, `classification`, `approval_required` | data may not leave, or needs a human approval |
| `circuit_open`, `peer_unavailable`, `executor_busy` | executor unhealthy, unreachable, or already working on this task |
| `skill_mismatch`, `not_decomposable`, `insufficient_peers` | peer lacks a required skill; task too coupled to delegate or parallelise |
| `local_unavailable`, `local_attempts_exhausted`, `peer_attempts_exhausted` | attempt caps |
| `verifier_unavailable`, `nothing_to_verify`, `no_conflict`, `tier_unsupported` | action not applicable |
| `not_worth_cost` | permitted, but failed the LCB value gate |

`whyNotDelegate()` summarises the delegate candidates' reasons into the decision text, for example
`delegation not taken: not_decomposable (peer-a, peer-b)`.

## Coupling semantics

`dependencyCoupling` is a feature, not ground truth. Thresholds: ≤ 0.45 parallelisable, ≤ 0.75 delegable as a
whole, above that tied to local context. The heuristic estimator maps the hint `independentSubtasks: true` to
0.2 and `false` to 0.6 (not parallelisable, still delegable). Only an explicit manual profile marks a task as bound
to local context. The benchmark in `docs/evaluation.md` shows why this distinction matters.

## Exploration and off-policy learning (V2 hooks, design §7.2)

With `exploration.enabled`, and only for tasks that are `public`, verifiable and opted in with
`safeForExploration`, the policy picks uniformly among **permitted** actions with probability ε. Permitted means
not blocked by any hard constraint; actions rejected only by the value gate are included, which is the point.
The PRNG is seeded from `(seed, taskId, decisionIndex)`, so replays are exact, and the logging propensity is
recorded with every decision.

`policy/src/ope.ts` provides IPS, self-normalised IPS and doubly-robust estimators plus a coverage report (n,
effective sample size, minimum propensity, maximum weight). `CoverageGatedPolicy` uses a learned `ValueModel`
only when the coverage report passes; otherwise, and for every hard-rule decision, it is exactly the rule policy.

## Calibration

Self-reported confidence is a weak signal. `ShrinkageCalibrator` blends it with the executor's observed
reliability, and the more history there is, the less the self-report counts. `PlattCalibrator.fit` (logistic fit
with label smoothing, a base-rate start and a line search) and `expectedCalibrationError` support calibration reports.

## Baselines

`LocalOnlyPolicy`, `FixedTopologyPolicy` and `ConfidenceGatedPolicy` reuse the DVO candidate generator. They obey
exactly the same hard limits, safety gates, budgets and verification step; only the choice among permitted actions
differs. That is what makes the comparisons in `docs/evaluation.md` compute-matched.
