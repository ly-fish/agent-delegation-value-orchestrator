# 0006 — A dedicated `orchestrator` package for the control loop

**Context.** Design §13 lists `core`, `policy`, `scheduler`, the bridges, `evidence`, `verifier`, `trace` and
`testkit`, and `apps/service` for "HTTP/API and process wiring". The control loop (ingress, decision loop,
finalizer, recovery) fits none of them without violating their stated responsibilities.

**Decision.** Add `packages/orchestrator`. It depends only on ports and domain packages, never on a bridge; the
service injects concrete executors.

**Consequences.** The whole engine is testable in virtual time with scripted executors, and `apps/service` stays a
thin composition root. The architecture check encodes the new edges.
