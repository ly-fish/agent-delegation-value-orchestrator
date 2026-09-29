# Changelog

## 0.1.0 — 2026-09-29

First implementation of the *DeepSeek Harness + A2A Delegation Value Orchestrator* design (milestones M0–M4, V2 hooks).

### Added

- **Core:** branded identifiers (UUIDv7, W3C trace ids), budgets with in-flight reservations, task and attempt
  state machines, event-sourced task projection, ports for stores, executors, verifiers, logging, metrics and secrets.
- **Policy:** DVO rule policy with lower-confidence-bound value gating, full candidate logging with block reasons,
  reproducible ε-exploration with propensities, hardness heuristics, shrinkage and Platt calibration, IPS / SNIPS /
  doubly-robust estimators, coverage-gated learned-policy wrapper, local-only / fixed-topology / confidence-gated baselines.
- **Scheduler:** FIFO semaphores (global and per executor), deadline-driven cancellation with a grace period,
  jittered retry, circuit breakers with half-open probes and operator control.
- **Evidence:** versioned EvidenceEnvelope (zod + published JSON Schema), redaction, prompt-injection screening,
  artifact admission and quarantined download, trust gateway, egress minimisation.
- **Verifiers:** exact answer, regex, sandboxed command, artifact digest; all schedulable as executors.
- **Trace:** SQLite and in-memory stores with a shared contract suite, transactional outbox, idempotent reliability
  outcomes, replay (projection check, decision re-run, recorded executors), redacted JSONL export, Prometheus metrics.
- **DSH bridge:** one-shot `headless --json` executor with a version lock, profile digest, allowlisted environment,
  credential injection, token metering and process-group kill; validated against `@deepseek-ai/dsh@0.2.0-rc.1`.
- **A2A bridge:** v1.0 JSON-RPC client, Agent Card discovery with allowlist and caching, outbox-driven submission with
  deterministic `messageId`, delivery classification, monotonic polling, best-effort cancel with late results,
  extension and tier-0 fallback, restart resume; interop-tested with `@a2a-js/sdk@1.2.1`.
- **Orchestrator:** ingress with idempotency keys and redaction, per-task actor loop with hedged verification and
  early stop, finalizer with verification labels, restart recovery, reliability tracking, human approvals.
- **Service:** YAML configuration with validation, secret provider, Fastify API, CLI, redacting structured logs,
  Dockerfile and compose demo, CI workflow.
- **Evaluation:** controlled-DAG benchmark (compute-matched, virtual time, 3D Pareto) and a reference A2A peer built on
  the official SDK.
