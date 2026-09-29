# Design traceability

How each part of the technical design ([design/technical-design.zh.md](design/technical-design.zh.md)) is realised,
and which tests hold it in place.

| Design § | Requirement | Implementation | Tests |
|---|---|---|---|
| 1 | local / delegate / parallel / verify / stop under a fixed budget; traceable, cancellable, idempotent | `orchestrator/engine.ts`, `policy/rule-policy.ts` | `engine.test.ts` |
| 2.2 | single hop, read-only remote, polling only, no webhooks, no hot-plugging | `a2a-bridge/peer-executor.ts` (polling), composition at start-up | `a2a-bridge.contract.test.ts` |
| 3.2 (1) | owner, deadline, budget, idempotency key on every side effect | `core/correlation.ts`, `orchestrator/engine.ts#request` | `engine.test.ts` |
| 3.2 (2) | terminal state irreversible; duplicates / reordering never change it | `core/attempt.ts`, `core/projection.ts`, `a2a-bridge` observe() | `state-machines.test.ts`, `projection.test.ts`, contract tests |
| 3.2 (3) | cancel is best effort; `cancel_requested` recorded at once; late results audited | `engine.ts#cancelActive`, `#onResult` | `engine.test.ts` (user cancel, hedging) |
| 3.2 (4) | Agent Card is candidate information only | `a2a-bridge/card-resolver.ts`, `orchestrator/reliability.ts` | `a2a-bridge.contract.test.ts` |
| 3.2 (5) | remote data untrusted; schema, URI, MIME, size, hash checked | `evidence/schema.ts`, `evidence/artifact.ts`, `evidence/gateway.ts` | `boundary.test.ts` |
| 3.2 (6) | no secrets, auth headers, private context or CoT in logs | `evidence/redaction.ts`, store sanitiser, `service/logging.ts`, DSH thinking drop | `boundary.test.ts`, `service.test.ts`, `dsh-bridge.contract.test.ts` |
| 3.2 (7) | policy cannot break budgets, permissions or approvals | hard stops and blocks in `rule-policy.ts`; egress guard in engine | `rule-policy.test.ts`, `engine.test.ts` |
| 4.1 | module responsibilities | one package per module, see README | `scripts/check-architecture.mjs` |
| 4.2 | one Node process + SQLite | `apps/service`, `trace/store/sqlite.ts` | `service.test.ts`, `recovery.test.ts` |
| 5.1 | Correlation ids | `core/ids.ts`, `core/correlation.ts` (UUIDv7, W3C trace ids) | `primitives.test.ts` |
| 5.2 | TaskState with CAS revision, budget | `core/task.ts`, `core/budget.ts` (with reservations) | `projection.test.ts`, `store-contract.test.ts` |
| 5.3 | hardness as features | `core/hardness.ts`, `policy/hardness.ts` | `learning.test.ts` |
| 5.4 | actions and decision records with rejected candidates | `core/actions.ts`, `DecisionRecord` in `decision.made` | `rule-policy.test.ts`, `engine.test.ts` |
| 6 | EvidenceEnvelope tiers, schema, inbound checks | `core/evidence.ts`, `evidence/*`, `schemas/evidence-envelope.v1.json` | `schema-and-redaction.test.ts`, `boundary.test.ts` |
| 7.1 | rules + calibrated gating; `mayEscalate` hard constraints | `policy/rule-policy.ts`, `policy/value.ts` | `rule-policy.test.ts` |
| 7.2 | exploration with propensities; DR estimation; LCB; fallback to rules | `rule-policy.ts#maybeExplore`, `policy/ope.ts`, `CoverageGatedPolicy` | `learning.test.ts`, benchmark |
| 8.1 | Executor interface; DSH behind an adapter | `core/execution.ts`, `dsh-bridge` | `dsh-bridge.contract.test.ts` |
| 8.2 | one-shot, depth-limited; deadline, token cap, tool allowlist, structured output; runtime provenance in traces | `dsh-executor.ts`, `configs/dsh/dvo-headless.patch.yml`, `RuntimeInfo` | same; smoke-tested against the real DSH 0.2.0-rc.1 |
| 8.3 | version lock, contract tests (success / timeout / cancel / bad output / crash) | `configs/runtime-lock.yaml`, `profileDigest`, version enforcement | `dsh-bridge.contract.test.ts` |
| 9.1 | peer lifecycle: discover → validate → cache → select → outbox submit → poll → artifacts → stats | `card-resolver.ts`, `peer-executor.ts`, `reliability.ts` | contract and interop tests |
| 9.2 | object mapping | `a2a-bridge/mapping.ts` | contract tests |
| 9.3 | pinned versions, extension URI, fallbacks for extension / streaming / cancel | `wire.ts`, `mapping.ts`, `peer-executor.ts#cancelRemote` | contract tests |
| 9.4 | https allowlist, secret provider, per-peer limits, circuit breaker | `card-resolver.ts`, `service/secrets.ts`, scheduler | contract tests, `scheduler.test.ts` |
| 10.1 | attempt state machine | `core/attempt.ts` | `state-machines.test.ts` |
| 10.2 | recovery rules (unknown submission, duplicates, reordering, restart, crash, verifier down, circuits, budget) | engine, outbox, bridges | `recovery.test.ts`, contract tests, `engine.test.ts` |
| 10.3 | CAS, append-only events, per-task and per-peer concurrency, jittered retry | stores, `TaskActor`, `scheduler/*` | `store-contract.test.ts`, `scheduler.test.ts` |
| 11.1 | SQLite tables, redacted payloads, transactional outbox | `trace/store/migrations.ts`, `sqlite.ts` | `store-contract.test.ts` |
| 11.2 | metrics | `core/metrics.ts`, `trace/metrics.ts` | `metrics.test.ts`, `service.test.ts` |
| 11.3 | replay: rebuild, re-run decisions, recorded executors, rejected candidates, JSONL export | `trace/replay.ts`, `trace/export.ts`, CLI | `engine.test.ts`, `service.test.ts` |
| 12 | classification, permissions, isolated verification | `evidence/egress.ts`, `verifier/command.ts`, approvals API | `boundary.test.ts`, `verifiers.test.ts`, `engine.test.ts` |
| 13 | repository layout, one-way dependencies | this repository; architecture check | CI |
| 14 | M0–M4 | M0–M4 delivered; M5 hooks only | — |
| 15 | quality gates | strict TS, ESLint (no floating promises), Prettier, coverage gates, secret scan, schema drift | `.github/workflows/ci.yml` |
| 16.1 | engineering acceptance | see README "Guarantees" | as listed there |
| 16.2 | research acceptance: success–cost–latency curves, compute-matched baselines, replayable decisions, unseen peers | `evals/controlled-dag`, `docs/evaluation.md` | `controlled-dag.test.ts` |
| 18 | configuration inputs | `configs/*` | `service.test.ts` |

## Deviations from the design, and why

* **An `orchestrator` package** that §13 does not list. The design wants `apps/service` to be only HTTP and
  process wiring, and `core` to be free of infrastructure, so the control loop needed a home of its own
  ([ADR 0006](adr/0006-orchestrator-package.md)).
* **`Executor.prepare()` and an `ExecutionObserver`** extend the §8.1 interface. The transactional outbox needs the
  request digest before sending, and the engine needs `remote_submitted` progress to move attempts to `awaiting_peer`.
* **Two extra attempt transitions** (`queued → cancelled`, `awaiting_peer → failed`), both conservative
  ([architecture.md](architecture.md#attempt-lifecycle-design-101)).
* **`verify` carries its target attempts**, and the policy input includes per-executor activity, so the engine can
  verify results while other attempts are still in flight.
* **Reliability is recorded once per attempt, keyed by attempt id** (`executor_outcomes` table). Verified outcomes
  count as successes and refuted ones as failures, which keeps "reliability" meaning *correctness*, not "responded".
