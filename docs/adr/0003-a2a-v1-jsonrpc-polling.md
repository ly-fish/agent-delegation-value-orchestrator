# 0003 — A2A v1.0 over JSON-RPC, polling only, own client

**Context.** The MVP fixes a star topology, single hop, read-only peers and polling (§2.2, §9.3). The official
`@a2a-js/sdk` provides client and server for v1.0.

**Decision.** `a2a-bridge` implements a narrow JSON-RPC client itself (`SendMessage`, `GetTask`, `CancelTask`,
Agent Card discovery) with zod-validated wire objects. The official SDK is used as the **reference server** in
contract tests, and to build the demo peer.

**Why not the SDK client?** The bridge must classify every transport failure by whether the request may have been
processed (connect refused and HTTP 429 are safe to retry; resets, timeouts and 5xx are not), cap response sizes,
refuse redirects and card-advertised hosts outside the allowlist, and drive a persisted outbox. Owning a few
hundred lines of client code makes those guarantees explicit and testable, and the interop suite keeps it honest.

**Consequences.** No streaming, push notifications or gRPC/REST bindings in the MVP. The interop test also documents
a fact the design anticipated: the reference server does not de-duplicate by `messageId`.
