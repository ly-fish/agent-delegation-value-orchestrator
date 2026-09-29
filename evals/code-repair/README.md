# Code-repair task family (planned)

**Goal.** A real task family with a deterministic check: repair a small function so that its unit tests pass.

**Task shape.** Each task ships a buggy module and a test file. The candidate answer (a patched module) is written
to an isolated temporary directory and checked by a `command` verifier configured in `service.yaml`, e.g.
`[node, --test, {input}]`, with `shell: false`, a PATH-only environment and a hard timeout. The local DSH agent works
in its read-only sandbox; peers receive only the task scope and the failing test names (tier 0/1), never the repository.

**Questions it should answer.** Success–cost–latency against compute-matched baselines on a task where verification
is itself costly (seconds, not microseconds), and where retries of the same model are strongly correlated.

Not implemented yet; tracked as M4 follow-up work.
