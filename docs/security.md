# Security model

Remote agents are independent and may be adversarial. The local agent is trusted to run, but not trusted with
more than it needs. Model output is data, never instructions to the orchestrator. The controls below map to
design §3.2 and §12.

## Trust boundaries and controls

| Threat | Control | Where |
|---|---|---|
| Sensitive data sent to a peer | classification gate (`public < internal < restricted < secret`); peers cleared by trust tier; `restricted` needs clearance + `allowRestricted` + per-task human approval; `secret` never leaves | `evidence/egress.ts`, `policy/rule-policy.ts` |
| Credentials in a task goal | ingress redaction; a goal that contained a credential is escalated to `restricted` (local only) | `orchestrator/ingress.ts` |
| Credentials in logs, traces, metrics, exports | Redactor at ingress, gateway, egress and store, and in the pino formatter; `SecretValue` wrapper; label allowlists in metrics | `evidence/redaction.ts`, `trace/store/*`, `service/logging.ts` |
| Chain-of-thought persisted | DSH `thinking` events and stderr reasoning discarded in the bridge; A2A carries envelopes only | `dsh-bridge/dsh-executor.ts` |
| Prompt injection via peer output | framed as untrusted data; high-risk content quarantined (never enters a prompt); only verifiers can mark `verified` | `evidence/injection.ts`, `evidence/gateway.ts`, `orchestrator/prompts.ts` |
| Malicious artifacts / SSRF | https-only, host allowlist, private-address refusal, no credentials in URLs, MIME and size limits, SHA-256, redirects refused, byte cap while streaming, quarantine with mode 0600, never executed | `evidence/artifact.ts` |
| Agent Card redirects traffic | JSON-RPC URL must be on the peer's allowlisted hosts and https; cards are candidate info, not trust | `a2a-bridge/card-resolver.ts` |
| Peer-supplied verification commands | ignored; recipes come only from local configuration; command verifiers run with `shell: false`, a fresh temp dir, PATH-only environment and a hard timeout | `verifier/command.ts` |
| Local agent over-reach | one-shot headless runner; patch pins a read-only sandbox, approval `never` and no in-process subagents; environment rebuilt from an allowlist; the prompt is passed on stdin, not argv | `configs/dsh/dvo-headless.patch.yml`, `dsh-bridge` |
| Runaway cost | hard budgets with reservations; token metering kills the local run at its budget; per-executor semaphores and circuit breakers | `core/budget.ts`, `scheduler/*` |
| Duplicate side effects | client idempotency keys, transactional outbox, deterministic `messageId`, no blind resends | `orchestrator/ingress.ts`, `a2a-bridge/peer-executor.ts` |
| Unauthenticated API use | optional bearer token on `/v1/*`, constant-time comparison; body size limit; zod validation | `service/http/server.ts` |

## What is *not* covered

* **Network egress control** beyond the per-peer allowlist. Use an egress proxy in cross-trust-domain deployments
  (`NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` / `NO_PROXY`) and mTLS where peers support it.
* **Agent Card signatures.** A2A v1.0 cards may be JWS-signed. Signature verification is not implemented, and a
  valid signature would still only be candidate information.
* **The heuristic injection screen is not a classifier.** It limits exposure; the structural defences (data framing,
  quarantine, verifier-only promotion) are what contain it.
* The DSH sandbox is DSH's own. The orchestrator pins its configuration but does not re-implement it.

## Secret scanning

`npm run check:secrets` runs in CI. Test fixtures that exercise redaction use synthetic keys (repeated characters
or explicit test words) and are allowed only under `test/`.
