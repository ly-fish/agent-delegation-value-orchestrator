# Operations runbook

## Configuration

`harness` reads four files from the configuration directory (`--config-dir`, `$HARNESS_CONFIG_DIR`, default
`./configs`). For each, `<name>.yaml` takes precedence over the tracked `<name>.example.yaml`. Relative paths
inside the files resolve against the configuration directory.

| File | Contents |
|---|---|
| `service.yaml` | HTTP, storage, secrets, logging, scheduler limits, ingress ceilings and defaults, local runtime, verifiers |
| `peers.yaml` | allowlisted A2A peers (appendix B), per-peer trust tier, limits, credentials reference, extensions |
| `policy.yaml` | DVO policy knobs, engine behaviour, circuit breakers, reliability priors |
| `runtime-lock.yaml` | pinned Node, A2A protocol versions, DSH version / commit / profile / patch / model route / pricing |

`harness config check` validates everything and prints a summary without secrets. Environment overrides:
`HARNESS_HTTP_HOST`, `HARNESS_HTTP_PORT`.

## Secrets

Configuration contains only `secret://…` references. `EnvFileSecretProvider` resolves `secret://a/b-c` from the
environment variable `HARNESS_SECRET_A_B_C`, then from the file `<secrets.dir>/a/b-c` (for example a mounted
secrets volume). Resolved values are `SecretValue` objects: every stringification yields `[REDACTED]`. They are
revealed only at the moment they are placed in a request header or a child's environment.

| Reference in the default configs | Used for |
|---|---|
| `secret://orchestrator/dsh/deepseek-api-key` | `DEEPSEEK_API_KEY` in the DSH child environment |
| `secret://orchestrator/a2a/<peer-id>` | `Authorization: Bearer …` (or the configured API-key header) for that peer |
| `secret://orchestrator/api-token` | bearer token required on `/v1/*` (when `http.apiTokenRef` is set) |

## Running

```bash
npm run build && node apps/service/dist/main.js    # = harness serve
docker compose up --build                           # demo stack (configs/demo)
docker build --build-arg INSTALL_DSH=true -t harness-dvo .   # image with the pinned DSH launcher
```

On start the service runs **restart recovery** before opening the listener (see
[architecture.md](architecture.md#restart-recovery-design-102)). On `SIGTERM` or `SIGINT` it stops accepting
requests and leaves remote attempts submitted; they are resumed on the next start.

## Health

* `GET /healthz`: process liveness.
* `GET /readyz`: store reachable, local runtime probe (version lock), circuit state per peer. Returns `503` if
  the store is unavailable.
* `harness peers check`: fetches and validates every allowlisted Agent Card and prints capabilities.

## Metrics (design §11.2)

Prometheus text format at `/metrics`. Names are declared once in `packages/core/src/metrics.ts`.

| Area | Metrics |
|---|---|
| tasks | `dvo_tasks_total{outcome,verification}`, `dvo_task_cost_usd`, `dvo_task_tokens_total{direction}`, `dvo_task_duration_seconds{outcome}` |
| decisions | `dvo_decisions_total{action,explored,policy}`, `dvo_decision_blocked_total{action,reason}` |
| attempts | `dvo_attempts_total{executor,kind,terminal}`, `dvo_attempt_duration_seconds{executor}`, `dvo_attempts_active`, `dvo_late_results_total`, `dvo_transitions_rejected_total{entity}` |
| peers | `dvo_peer_requests_total{peer,method,outcome}`, `dvo_peer_submission_unknown_total{peer}`, `dvo_circuit_state{peer}` |
| evidence | `dvo_evidence_envelopes_total{direction,tier}`, `dvo_evidence_bytes{direction}`, `dvo_evidence_outcome_total{outcome}`, `dvo_artifact_rejections_total`, `dvo_injection_flags_total{level}`, `dvo_redactions_total{where}` |
| system | `dvo_scheduler_queue_length{pool}`, `dvo_retries_total{operation}`, `dvo_recovery_duration_seconds`, `dvo_recovered_attempts_total{action}`, `dvo_budget_violations_total{dimension}` |

Alert on `dvo_budget_violations_total > 0` (a reported usage exceeded a hard limit), sustained
`dvo_circuit_state == 2`, and growth of `dvo_peer_submission_unknown_total`.

## Common procedures

**A peer keeps failing.** Its circuit opens after `circuit.failureThreshold` consecutive infrastructure failures;
the policy then excludes it (`circuit_open`). After `cooldownMs` one probe is allowed (half-open). To take a peer out
by hand: `POST /v1/peers/<id>/circuit/trip`. It stays open until `POST /v1/peers/<id>/circuit/reset`.

**`submission_unknown` on a peer.** The request may or may not have reached the peer. It is not resent unless
the peer is configured `dedupSupported: true`, which you should only set for peers you control that de-duplicate
by `messageId`. The task continues with other actions; the event log records what happened.

**Restricted data needs a remote peer.** The peer must have `trustTier: restricted` and `allowRestricted: true`, and
a human must approve the specific task: `POST /v1/tasks/<id>/approvals {"approver":"…","reason":"…"}`.

**Verifier unavailable.** The task is marked `degraded`; nothing is ever labelled `verified`. The final answer, if
any, is returned as `unverified`.

**Upgrading DSH.** Bump `configs/runtime-lock.yaml` (version, commit), check the patch with
`dsh --profile headless --patch configs/dsh/dvo-headless.patch.yml --dump-config`, and run the full suite. The profile
digest recorded in every trace changes with the upgrade, so traces stay attributable.

## Investigating a task

```bash
curl -s localhost:8080/v1/tasks/<id>             # state, attempts, answers, diagnostics
curl -s localhost:8080/v1/tasks/<id>/decisions   # every decision with candidates and block reasons
harness replay <id>                              # projection check + deterministic re-run of every decision
harness export --kind decisions --out rows.jsonl # research rows (features, candidates, propensity, outcome)
```

## Data retention

SQLite (`storage.sqlitePath`, WAL mode) holds redacted events, projections, the outbox, reliability statistics and
artifact metadata. Quarantined artifact bytes live under `storage.quarantineDir`. Nothing in either location may
contain credentials: every write passes the Redactor. Rotate or archive the database per your retention policy;
exports are redacted JSONL.
