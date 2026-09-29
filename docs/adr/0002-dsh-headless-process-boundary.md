# 0002 — Drive DeepSeek Harness through its one-shot headless runner

**Context.** DSH is in developer preview with breaking changes expected (§3.1, §8.3). It offers a web app, a
JSON-RPC SDK profile, an ACP server and a `headless` one-shot runner with `--json` NDJSON events.

**Decision.** `dsh-bridge` spawns `dsh --profile headless --patch <locked overlay> --json -` per attempt. The prompt
goes on stdin, the child gets its own process group, and its environment is rebuilt from an allowlist. It is killed
at the deadline or token budget. The overlay pins a read-only sandbox, approval `never`, no in-process subagents
and a matching permission preset. The version is probed and enforced, and a profile digest (patch bytes, model
route, tool allowlist, version) is recorded in every trace.

**Alternatives.** The TypeScript SDK (a long-lived JSON-RPC child) would allow multi-turn sessions and avoid
start-up cost, but it couples the bridge to a larger, more volatile API surface. The headless runner's contract is a
documented, versioned process boundary that is trivially faked in tests.

**Consequences.** One process per attempt, a clean kill semantics and no DSH types in the core. Validated against the
published `@deepseek-ai/dsh@0.2.0-rc.1`: version probe, `--dump-config` of the overlay, and the event stream up to the
model call, including its structured `turn_end.reason` objects.
