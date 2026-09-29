# Evaluations

Research evaluation of the Delegation Value Orchestrator (design §14 M4, §16.2). Every task family is scored by a
**deterministic verifier**, never an LLM judge, and every strategy runs under an identical hard budget.

| Family | Status | Verifier | Run |
|---|---|---|---|
| [`controlled-dag/`](controlled-dag/) | implemented | exact answer | `npm run eval:dag -- --tasks 300 --seed 7` |
| [`tool-use/`](tool-use/) | specified | exact answer over tool results | — |
| [`code-repair/`](code-repair/) | specified | unit tests (`command` verifier) | — |

Results, methodology and threats to validity: [docs/evaluation.md](../docs/evaluation.md). Raw outputs (JSON with
per-task outcomes, plus a Markdown summary) are written to `evals/results/`, which git ignores.
