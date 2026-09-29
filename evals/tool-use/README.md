# Tool-use task family (planned)

**Goal.** Measure delegation value when answers require information that is fragmented across tools, so that
`informationFragmentation` rather than `reasoningDepth` drives hardness.

**Task shape.** Each task names a small synthetic knowledge base split across 2–5 "tools" (key-value lookups with
latency and failure profiles). Peers are given different tool subsets as declared skills. The answer is a
deterministic function of the looked-up values, checked by the `exact-answer` verifier.

**Questions it should answer.** Does DVO route by declared skill *and* observed reliability rather than by card
claims alone? How does `request_evidence` (a tier-1 upgrade with sources) change outcomes when two peers disagree
and the verifier is hidden until the end?

Not implemented yet; tracked as M4 follow-up work.
