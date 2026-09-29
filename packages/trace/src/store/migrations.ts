/**
 * Forward-only schema migrations. Never edit a released migration; append a new one.
 * Table names follow design §11.1; `executor_outcomes` makes reliability recording
 * idempotent per attempt.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE tasks (
        task_id            TEXT PRIMARY KEY,
        phase              TEXT NOT NULL,
        revision           INTEGER NOT NULL,
        classification     TEXT NOT NULL,
        budget_json        TEXT NOT NULL,
        state_json         TEXT NOT NULL,
        client_request_key TEXT UNIQUE,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX tasks_phase ON tasks (phase);

      CREATE TABLE attempts (
        attempt_id     TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks (task_id),
        executor_id    TEXT NOT NULL,
        executor_kind  TEXT NOT NULL,
        status         TEXT NOT NULL,
        deadline_at    TEXT NOT NULL,
        remote_task_id TEXT,
        verification   TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX attempts_task ON attempts (task_id);
      CREATE INDEX attempts_status ON attempts (status);

      CREATE TABLE events (
        seq              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id         TEXT NOT NULL UNIQUE,
        task_id          TEXT NOT NULL REFERENCES tasks (task_id),
        revision         INTEGER NOT NULL,
        trace_id         TEXT NOT NULL,
        attempt_id       TEXT,
        type             TEXT NOT NULL,
        payload_redacted TEXT NOT NULL,
        occurred_at      TEXT NOT NULL,
        UNIQUE (task_id, revision)
      );
      CREATE INDEX events_trace ON events (trace_id);

      CREATE TABLE outbox (
        outbox_id       TEXT PRIMARY KEY,
        attempt_id      TEXT NOT NULL UNIQUE,
        task_id         TEXT NOT NULL REFERENCES tasks (task_id),
        peer_id         TEXT NOT NULL,
        request_digest  TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state           TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        remote_task_id  TEXT,
        send_count      INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_retry_at   TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX outbox_state ON outbox (state);

      CREATE TABLE decisions (
        event_id        TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks (task_id),
        decision_index  INTEGER NOT NULL,
        policy_version  TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        selected_json   TEXT NOT NULL,
        record_json     TEXT NOT NULL,
        occurred_at     TEXT NOT NULL
      );
      CREATE INDEX decisions_task ON decisions (task_id, decision_index);

      CREATE TABLE peers (
        peer_id            TEXT PRIMARY KEY,
        card_digest        TEXT,
        last_seen_at       TEXT,
        trust_tier         TEXT NOT NULL,
        circuit            TEXT NOT NULL,
        circuit_changed_at TEXT
      );

      CREATE TABLE executor_outcomes (
        attempt_id       TEXT PRIMARY KEY,
        executor_id      TEXT NOT NULL,
        skill            TEXT NOT NULL,
        success          INTEGER NOT NULL,
        terminal_status  TEXT NOT NULL,
        latency_ms       REAL NOT NULL,
        cost_usd         REAL NOT NULL,
        artifact_failure INTEGER NOT NULL,
        at               TEXT NOT NULL
      );

      CREATE TABLE peer_stats (
        peer_id                TEXT NOT NULL,
        skill                  TEXT NOT NULL,
        success_count          INTEGER NOT NULL,
        failure_count          INTEGER NOT NULL,
        timeout_count          INTEGER NOT NULL,
        cancel_count           INTEGER NOT NULL,
        artifact_failure_count INTEGER NOT NULL,
        total_cost_usd         REAL NOT NULL,
        latency_histogram      TEXT NOT NULL,
        PRIMARY KEY (peer_id, skill)
      );

      CREATE TABLE artifacts (
        artifact_id       TEXT PRIMARY KEY,
        sha256            TEXT NOT NULL,
        attempt_id        TEXT NOT NULL,
        uri               TEXT,
        mime_type         TEXT,
        bytes             INTEGER NOT NULL,
        validation_status TEXT NOT NULL,
        reason            TEXT,
        stored_path       TEXT,
        recorded_at       TEXT NOT NULL
      );
      CREATE INDEX artifacts_sha ON artifacts (sha256);
    `,
  },
];
