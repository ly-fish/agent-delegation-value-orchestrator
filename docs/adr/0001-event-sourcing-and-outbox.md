# 0001 — Event-sourced task log with a transactional outbox

**Context.** The design requires irreversible terminal states, audit of late or duplicate inputs, restart recovery
and replay (§3.2, §10, §11). Remote submissions must be distinguishable as "never sent" versus "maybe sent".

**Decision.** Every task change is an immutable `DomainEvent`. The task state is a pure fold over the log
(`core/projection.ts`), shared by the engine, the store projection and the replayer. Commits are atomic and CAS-guarded
on the task revision. Remote attempts get an outbox row in the *same* transaction as the `attempt.created` event; the
peer executor moves it `pending → sending → submitted | submission_unknown | abandoned`.

**Consequences.** Replays are exact, and audit events explain everything that was ignored. Budgets are part of the
fold, so reservations survive restarts. The cost is a write per state change and a stricter event schema discipline:
the reducer throws on corrupt logs instead of guessing.
