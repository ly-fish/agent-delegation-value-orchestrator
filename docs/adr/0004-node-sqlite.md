# 0004 — Node's built-in `node:sqlite` for the single-node store

**Context.** The MVP needs a durable single-node store (§11.1). `better-sqlite3` is the usual choice but requires a
native build per Node ABI.

**Decision.** Use `node:sqlite` (`DatabaseSync`, SQLite 3.53 in Node 24.21) behind the `HarnessStore` port, with WAL,
`BEGIN IMMEDIATE` transactions and forward-only migrations. An `InMemoryStore` implements the same contract; both
pass one shared contract suite.

**Consequences.** Zero native dependencies and a smaller image. `node:sqlite` is still marked as under active
development in Node 24; the port boundary keeps swapping it cheap.
