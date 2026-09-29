# Evidence contract

Agents in different runtimes share no working memory, and chain-of-thought is never exchanged. They exchange
**EvidenceEnvelopes** (design §6): versioned, size-limited, verifiable payloads. The JSON Schema of the wire
form is published at [`schemas/evidence-envelope.v1.json`](../schemas/evidence-envelope.v1.json) and generated
from the zod source with `npm run schemas`; CI fails on drift.

## Shape (v1.0)

```jsonc
{
  "schemaVersion": "1.0",            // any 1.x is accepted and normalised; other majors are rejected
  "correlation": { … },              // optional from producers; the trusted request correlation replaces it
  "tier": 1,                         // 0 summary · 1 claims + evidence · 2 reproducible artifacts
  "taskScope": "one line restating the task",
  "claims": [
    { "id": "answer", "statement": "391", "confidence": 0.9,
      "assumptions": [], "dependencies": [], "status": "proposed" }
  ],
  "evidence": [
    { "kind": "tool-result", "summary": "evaluated with a calculator" },
    { "kind": "artifact", "summary": "proof", "uri": "https://…", "mimeType": "application/json",
      "bytes": 812, "sha256": "…64 hex…" }
  ],
  "requestedNextAction": "optional",
  "redactionApplied": false
}
```

Conventions:

* **Claim ids are question keys.** Claims with the same id from different sources answer the same question, which
  is how conflicts are detected. The primary answer uses id `answer`. Statements are compared after normalisation
  (NFKC, case-folded, whitespace collapsed, numbers canonicalised: `42.0` = `+42` = `42`).
* **Confidence is self-reported** and only ever a weak signal (see [policy.md](policy.md#calibration)).
* **`verifierHint` is informational.** It is never executed; verification recipes come only from local configuration.

## Inbound validation (design §6.3)

1. **Structure (bridges):** JSON Schema via zod; total size ≤ 256 KiB; per-field limits (≤ 64 claims, statement ≤
   4 000 chars, …). Unknown fields are reported for the audit record and **stripped**, so they can never reach a
   prompt. A producer-supplied correlation for a different task is rejected.
2. **Trust (evidence gateway):**
   * `status: verified` from anyone but a local verifier is demoted to `supported`;
   * tiers above what the channel supports are downgraded, and artifacts are dropped below tier 2;
   * artifact references must pass the peer's policy before anyone fetches them: https only (loopback http only
     with an explicit dev flag), no credentials in the URL, allowlisted host, no private IP literal, allowlisted
     MIME type, declared size ≤ limit, declared SHA-256;
   * every string is redacted;
   * prompt-injection screening; high-risk envelopes are **quarantined**: they may reach isolated verifiers,
     never a model prompt.
3. **Downloads (when used):** streamed with a byte cap, redirects refused, content type and SHA-256 verified,
   then stored content-addressed with mode 0600 in the quarantine directory. Nothing is executed.

## Outbound minimisation (design §12)

| Tier sent | Claims | Evidence |
|---|---|---|
| 0 | statements, confidence, status (assumptions and dependencies removed) | none |
| 1 | full claims | summaries only (URIs, digests and hints removed) |
| 2 | full claims | summaries plus https artifact references (hints removed) |

The tier sent is the lower of what the action asks for and what the peer supports: 2 with the DVO extension,
0 without it.

## Transport over A2A (design §9.2–9.3)

Extension URI: `urn:research:dvo:evidence-envelope:v1`.

* **Peer declares the extension:** the request carries `A2A-Extensions: urn:…:v1`. `message.extensions` lists
  it, and `message.metadata[urn]` holds `{schemaVersion, idempotencyKey, requestedTier}`. The envelope travels
  as a Data Part (`mediaType: application/json`). The peer answers with an Artifact whose `extensions` include
  the URI and whose Data Part holds the envelope.
* **Peer does not declare it:** the envelope is minimised to tier 0 and sent as a plain Data Part; no extension
  header, metadata or idempotency key is sent. Answers are read from any envelope-shaped Data Part or, failing
  that, the text parts become a synthesized tier-0 envelope with self-reported confidence 0. `url` and `raw`
  parts become artifact evidence and are checked by the gateway.

The `messageId` of every submission is `uuidv5(idempotencyKey)`. The A2A spec allows servers to use it for
de-duplication, but does not require it, and the reference `@a2a-js/sdk` server does not.

## Transport from DSH

The DSH bridge appends a response contract to the local prompt: one JSON object in a fenced block. It extracts
that object from the headless runner's `final` event: the last fenced block, else bare JSON, else the last
balanced object. A final answer without a valid envelope makes the attempt `invalid_output` (retryable).
