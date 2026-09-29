# Security policy

Please report vulnerabilities privately to the maintainer (GitHub: [@ly-fish](https://github.com/ly-fish))
rather than in a public issue. Include steps to reproduce and the affected version or commit.

The threat model and the controls this project relies on are described in [docs/security.md](docs/security.md).
Reports are especially welcome for anything that lets a remote peer or model output:

* read local context, credentials or files, or cause a local side effect;
* get a claim labelled `verified` without a local verifier;
* cause a duplicate remote submission, or exceed a task's hard budget;
* place secrets or chain-of-thought into logs, traces, metrics or exports.
