# 0005 — Gate escalation on lower-confidence-bound value

**Context.** The design asks for explainable, testable gating that never claims causal optimality, and for
escalation decisions based on a calibrated lower bound rather than a point estimate (§7.1, §7.2).

**Decision.** Candidates are scored with a closed-form success model: identification with a verifier, selection by
confidence without one. Executor reliability comes from Beta posteriors over *verified* outcomes; the gate uses the
Wilson lower bound. An escalation must have `LCB gain > cost + risk` and a positive net value after latency cost.
Every candidate and its block reasons are persisted.

**Consequences.** Decisions are conservative, replayable and explainable. As the benchmark shows, the gate can
starve unproven peers at low task values (cold start); controlled, logged exploration on safe tasks is the designed
remedy, and it is available but off by default.
