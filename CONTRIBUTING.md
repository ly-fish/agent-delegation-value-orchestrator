# Contributing

## Setup

```bash
nvm use            # Node 24 LTS (.nvmrc)
npm ci
npm run check      # everything CI runs, locally
```

Source runs directly under Node's type stripping: `node --conditions=@dvo/source <file>.ts`. Tests always resolve
workspace packages to their sources, never to a stale `dist/`.

## Rules for changes (design §15)

* **TypeScript `strict`**, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and erasable syntax only (no enums,
  no parameter properties).
* **No floating promises.** Every promise is awaited, returned or explicitly `void`-ed; an unhandled rejection in
  the control plane is an orphaned attempt.
* **Respect the dependency graph.** `npm run check:architecture` must pass: infrastructure enters through ports,
  DSH only via `dsh-bridge`, A2A SDKs only via `a2a-bridge`, SQLite only via `trace`.
* **Policy changes** must include the replay of a representative task (`harness replay <taskId>`) and the
  controlled-DAG results before and after (`npm run eval:dag`).
* **Cross-boundary schema changes** (events, EvidenceEnvelope, config) need a compatibility test and, for the
  envelope, regenerated JSON Schema (`npm run schemas`; CI fails on drift). Never edit a released migration; append one.
* **Runtime upgrades** (DSH, A2A SDK, Node) go through `configs/runtime-lock.yaml` and must pass the full contract
  and chaos suites. For DSH, also check the overlay with `dsh --dump-config`.
* **No real secrets or personal data in fixtures.** Redaction tests use synthetic keys; `npm run check:secrets`
  enforces this.

## Tests

| Kind | Where |
|---|---|
| unit | `packages/*/test/*.test.ts` |
| contract | `dsh-bridge.contract.test.ts` (fake `dsh`), `a2a-bridge.contract.test.ts` (mock peer), `a2a-sdk.interop.test.ts` (official SDK server) |
| integration / chaos | `orchestrator/test/engine.test.ts` (virtual time), `recovery.test.ts` (real SQLite + HTTP) |
| service | `apps/service/test/service.test.ts` (Fastify inject) |
| evaluation | `evals/controlled-dag/controlled-dag.test.ts` (determinism, budget compliance) |

Prefer `FakeClock` and `ScriptedExecutor` for anything time-dependent; reach for real processes and sockets only in
contract tests.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), imperative mood, one logical change
per commit.
