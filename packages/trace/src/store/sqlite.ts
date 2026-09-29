import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  assertOutboxTransition,
  type ArtifactRecord,
  type AttemptId,
  type Clock,
  type DecisionRecord,
  type DomainEvent,
  type ExecutorOutcome,
  type ExecutorStats,
  HarnessError,
  type HarnessStore,
  type OutboxPatch,
  type OutboxRecord,
  type OutboxState,
  type PeerRecord,
  RevisionConflictError,
  systemClock,
  type TaskCommit,
  TaskId,
  type TaskPhase,
  type TaskState,
  type TaskSummary,
  toIso,
} from '@dvo/core';
import { applyOutcome, emptyStats, identitySanitizer, type Sanitizer, validateCommit } from './common.ts';
import { MIGRATIONS } from './migrations.ts';

type Row = Record<string, SQLInputValue>;

/** Typed column accessors: SQLite values are untyped at runtime, so every read is checked. */
function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  throw new HarnessError('internal', `column ${column} is not text`);
}

function optStr(row: Row, column: string): string | undefined {
  return row[column] === null || row[column] === undefined ? undefined : str(row, column);
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new HarnessError('internal', `column ${column} is not numeric`);
}

const TERMINAL_PHASES: readonly TaskPhase[] = ['succeeded', 'failed', 'cancelled', 'expired'];

/**
 * Single-node durable store on SQLite (design §11.1), via Node's built-in `node:sqlite`.
 * WAL journaling, `BEGIN IMMEDIATE` transactions, CAS on task revision, and the
 * transactional outbox written in the same transaction as the attempt that owns it.
 */
export class SqliteStore implements HarnessStore {
  readonly #db: DatabaseSync;
  readonly #sanitize: Sanitizer;
  readonly #clock: Clock;

  constructor(path: string, options: { sanitize?: Sanitizer; clock?: Clock; busyTimeoutMs?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#sanitize = options.sanitize ?? identitySanitizer;
    this.#clock = options.clock ?? systemClock;
    this.#db.exec(`PRAGMA busy_timeout = ${Math.floor(options.busyTimeoutMs ?? 5000)}`);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  /** Applied schema version (for health checks). */
  get schemaVersion(): number {
    const row = this.#db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.schemaVersion;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.#transaction(() => {
        this.#db.exec(migration.sql);
        this.#db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, toIso(this.#clock.now()));
      });
    }
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async commit(commit: TaskCommit): Promise<void> {
    validateCommit(commit);
    const now = toIso(this.#clock.now());
    const state = this.#sanitize(structuredClone(commit.state)) as TaskState;
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT revision FROM tasks WHERE task_id = ?').get(commit.taskId) as { revision: number } | undefined;
      const actual = row?.revision ?? 0;
      if (actual !== commit.expectedRevision) throw new RevisionConflictError(commit.taskId, commit.expectedRevision, actual);

      if (commit.expectedRevision === 0) {
        try {
          this.#db
            .prepare(
              `INSERT INTO tasks (task_id, phase, revision, classification, budget_json, state_json, client_request_key, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              state.taskId,
              state.phase,
              state.revision,
              state.classification,
              JSON.stringify(state.budget),
              JSON.stringify(state),
              state.clientRequestKey ?? null,
              state.createdAt,
              now,
            );
        } catch (error) {
          throw constraintError(error, 'duplicate task or client request key');
        }
      } else {
        const result = this.#db
          .prepare('UPDATE tasks SET phase = ?, revision = ?, state_json = ?, updated_at = ? WHERE task_id = ? AND revision = ?')
          .run(state.phase, state.revision, JSON.stringify(state), now, state.taskId, commit.expectedRevision);
        if (result.changes !== 1) throw new RevisionConflictError(commit.taskId, commit.expectedRevision, undefined);
      }

      const insertEvent = this.#db.prepare(
        `INSERT INTO events (event_id, task_id, revision, trace_id, attempt_id, type, payload_redacted, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertDecision = this.#db.prepare(
        `INSERT INTO decisions (event_id, task_id, decision_index, policy_version, candidates_json, selected_json, record_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      commit.events.forEach((raw, i) => {
        const event = this.#sanitize(structuredClone(raw)) as DomainEvent;
        try {
          insertEvent.run(
            event.eventId,
            event.taskId,
            commit.expectedRevision + i + 1,
            event.traceId,
            event.attemptId ?? null,
            event.type,
            JSON.stringify(event),
            event.occurredAt,
          );
        } catch (error) {
          throw constraintError(error, 'duplicate event id');
        }
        if (event.type === 'decision.made') {
          const record = event.payload.record;
          insertDecision.run(
            event.eventId,
            event.taskId,
            record.decisionIndex,
            record.policyVersion,
            JSON.stringify(record.candidateActions),
            JSON.stringify(record.selected),
            JSON.stringify(record),
            event.occurredAt,
          );
        }
      });

      const upsertAttempt = this.#db.prepare(
        `INSERT INTO attempts (attempt_id, task_id, executor_id, executor_kind, status, deadline_at, remote_task_id, verification, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET status = excluded.status, remote_task_id = excluded.remote_task_id,
           verification = excluded.verification, updated_at = excluded.updated_at`,
      );
      const touched = new Set(commit.events.flatMap((e) => (e.attemptId === undefined ? [] : [e.attemptId])));
      for (const e of commit.events) if (e.type === 'verification.recorded') touched.add(e.payload.targetAttemptId);
      for (const id of touched) {
        const attempt = state.attempts[id];
        if (attempt === undefined) continue;
        upsertAttempt.run(
          attempt.attemptId,
          state.taskId,
          attempt.executorId,
          attempt.executorKind,
          attempt.status,
          attempt.deadlineAt,
          attempt.remoteTaskId ?? null,
          attempt.verification,
          now,
        );
      }

      const insertOutbox = this.#db.prepare(
        `INSERT INTO outbox (outbox_id, attempt_id, task_id, peer_id, request_digest, idempotency_key, state, payload_json, remote_task_id, send_count, last_error, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      for (const raw of commit.outbox ?? []) {
        const r = this.#sanitize(structuredClone(raw)) as OutboxRecord;
        try {
          insertOutbox.run(
            r.attemptId,
            r.attemptId,
            r.taskId,
            r.peerId,
            r.requestDigest,
            r.idempotencyKey,
            r.state,
            JSON.stringify(r.payload),
            r.remoteTaskId ?? null,
            r.sendCount,
            r.lastError ?? null,
            r.createdAt,
            r.updatedAt,
          );
        } catch (error) {
          throw constraintError(error, 'duplicate outbox record');
        }
      }
    });
  }

  async load(taskId: TaskId): Promise<TaskState | undefined> {
    const row = this.#db.prepare('SELECT state_json FROM tasks WHERE task_id = ?').get(taskId) as { state_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state_json) as TaskState);
  }

  async events(taskId: TaskId): Promise<DomainEvent[]> {
    const rows = this.#db.prepare('SELECT payload_redacted FROM events WHERE task_id = ? ORDER BY revision').all(taskId) as Array<{
      payload_redacted: string;
    }>;
    return rows.map((r) => JSON.parse(r.payload_redacted) as DomainEvent);
  }

  async decisions(taskId: TaskId): Promise<DecisionRecord[]> {
    const rows = this.#db.prepare('SELECT record_json FROM decisions WHERE task_id = ? ORDER BY decision_index').all(taskId) as Array<{
      record_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.record_json) as DecisionRecord);
  }

  async findByClientKey(clientRequestKey: string): Promise<TaskId | undefined> {
    const row = this.#db.prepare('SELECT task_id FROM tasks WHERE client_request_key = ?').get(clientRequestKey) as
      { task_id: string } | undefined;
    return row === undefined ? undefined : TaskId(row.task_id);
  }

  async listTasks(filter: { nonTerminal?: boolean; limit?: number } = {}): Promise<TaskSummary[]> {
    const where = filter.nonTerminal === true ? `WHERE phase NOT IN (${TERMINAL_PHASES.map(() => '?').join(', ')})` : '';
    const params: SQLInputValue[] = filter.nonTerminal === true ? [...TERMINAL_PHASES] : [];
    const rows = this.#db
      .prepare(
        `SELECT task_id, phase, revision, classification, client_request_key, created_at, updated_at FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? -1) as Row[];
    return rows.map((r) => ({
      taskId: TaskId(str(r, 'task_id')),
      phase: str(r, 'phase') as TaskPhase,
      revision: num(r, 'revision'),
      classification: str(r, 'classification'),
      createdAt: str(r, 'created_at'),
      updatedAt: str(r, 'updated_at'),
      ...(optStr(r, 'client_request_key') === undefined ? {} : { clientRequestKey: str(r, 'client_request_key') }),
    }));
  }

  async getOutbox(attemptId: AttemptId): Promise<OutboxRecord | undefined> {
    const row = this.#db.prepare('SELECT * FROM outbox WHERE attempt_id = ?').get(attemptId) as Row | undefined;
    return row === undefined ? undefined : outboxFromRow(row);
  }

  async transitionOutbox(
    attemptId: AttemptId,
    expected: OutboxState | readonly OutboxState[],
    to: OutboxState,
    patch: OutboxPatch = {},
  ): Promise<OutboxRecord> {
    const allowed: readonly OutboxState[] = typeof expected === 'string' ? [expected] : expected;
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM outbox WHERE attempt_id = ?').get(attemptId) as Row | undefined;
      if (row === undefined) throw new HarnessError('not_found', 'outbox record not found');
      const current = outboxFromRow(row);
      if (!allowed.includes(current.state)) {
        throw new HarnessError('revision_conflict', 'outbox state changed concurrently', {
          details: { attemptId, expected: allowed, actual: current.state },
        });
      }
      assertOutboxTransition(current.state, to);
      const lastError = patch.lastError === undefined ? (current.lastError ?? null) : String(this.#sanitize(patch.lastError));
      this.#db
        .prepare(
          'UPDATE outbox SET state = ?, remote_task_id = ?, send_count = ?, last_error = ?, updated_at = ? WHERE attempt_id = ? AND state = ?',
        )
        .run(
          to,
          patch.remoteTaskId ?? current.remoteTaskId ?? null,
          current.sendCount + (patch.incrementSendCount === true ? 1 : 0),
          lastError,
          toIso(this.#clock.now()),
          attemptId,
          current.state,
        );
      return outboxFromRow(this.#db.prepare('SELECT * FROM outbox WHERE attempt_id = ?').get(attemptId) as Row);
    });
  }

  async listOutbox(states: readonly OutboxState[]): Promise<OutboxRecord[]> {
    if (states.length === 0) return [];
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at`)
      .all(...states) as Row[];
    return rows.map(outboxFromRow);
  }

  async recordOutcome(outcome: ExecutorOutcome): Promise<boolean> {
    return this.#transaction(() => {
      const inserted = this.#db
        .prepare(
          `INSERT OR IGNORE INTO executor_outcomes (attempt_id, executor_id, skill, success, terminal_status, latency_ms, cost_usd, artifact_failure, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.attemptId,
          outcome.executorId,
          outcome.skill,
          outcome.success ? 1 : 0,
          outcome.terminalStatus,
          outcome.latencyMs,
          outcome.costUsd,
          outcome.artifactFailure ? 1 : 0,
          outcome.at,
        );
      if (inserted.changes === 0) return false;
      const row = this.#db.prepare('SELECT * FROM peer_stats WHERE peer_id = ? AND skill = ?').get(outcome.executorId, outcome.skill) as
        Row | undefined;
      const next = applyOutcome(row === undefined ? emptyStats(outcome.executorId, outcome.skill) : statsFromRow(row), outcome);
      this.#db
        .prepare(
          `INSERT INTO peer_stats (peer_id, skill, success_count, failure_count, timeout_count, cancel_count, artifact_failure_count, total_cost_usd, latency_histogram)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(peer_id, skill) DO UPDATE SET success_count = excluded.success_count, failure_count = excluded.failure_count,
             timeout_count = excluded.timeout_count, cancel_count = excluded.cancel_count, artifact_failure_count = excluded.artifact_failure_count,
             total_cost_usd = excluded.total_cost_usd, latency_histogram = excluded.latency_histogram`,
        )
        .run(
          next.executorId,
          next.skill,
          next.successCount,
          next.failureCount,
          next.timeoutCount,
          next.cancelCount,
          next.artifactFailureCount,
          next.totalCostUsd,
          JSON.stringify(next.latency),
        );
      return true;
    });
  }

  async executorStats(): Promise<ExecutorStats[]> {
    return (this.#db.prepare('SELECT * FROM peer_stats ORDER BY peer_id, skill').all() as Row[]).map(statsFromRow);
  }

  async upsertPeer(record: PeerRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO peers (peer_id, card_digest, last_seen_at, trust_tier, circuit, circuit_changed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET card_digest = COALESCE(excluded.card_digest, peers.card_digest),
           last_seen_at = COALESCE(excluded.last_seen_at, peers.last_seen_at), trust_tier = excluded.trust_tier,
           circuit = excluded.circuit, circuit_changed_at = COALESCE(excluded.circuit_changed_at, peers.circuit_changed_at)`,
      )
      .run(
        record.peerId,
        record.cardDigest ?? null,
        record.lastSeenAt ?? null,
        record.trustTier,
        record.circuit,
        record.circuitChangedAt ?? null,
      );
  }

  async listPeers(): Promise<PeerRecord[]> {
    return (this.#db.prepare('SELECT * FROM peers ORDER BY peer_id').all() as Row[]).map((r) => ({
      peerId: str(r, 'peer_id') as PeerRecord['peerId'],
      trustTier: str(r, 'trust_tier') as PeerRecord['trustTier'],
      circuit: str(r, 'circuit') as PeerRecord['circuit'],
      ...(optStr(r, 'card_digest') === undefined ? {} : { cardDigest: str(r, 'card_digest') }),
      ...(optStr(r, 'last_seen_at') === undefined ? {} : { lastSeenAt: str(r, 'last_seen_at') }),
      ...(optStr(r, 'circuit_changed_at') === undefined ? {} : { circuitChangedAt: str(r, 'circuit_changed_at') }),
    }));
  }

  async putArtifact(record: ArtifactRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO artifacts (artifact_id, sha256, attempt_id, uri, mime_type, bytes, validation_status, reason, stored_path, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${record.sha256}:${record.attemptId}`,
        record.sha256,
        record.attemptId,
        record.uri ?? null,
        record.mimeType ?? null,
        record.bytes,
        record.validationStatus,
        record.reason ?? null,
        record.storedPath ?? null,
        record.recordedAt,
      );
  }

  async getArtifact(sha256: string): Promise<ArtifactRecord | undefined> {
    const r = this.#db.prepare('SELECT * FROM artifacts WHERE sha256 = ? ORDER BY recorded_at LIMIT 1').get(sha256) as Row | undefined;
    if (r === undefined) return undefined;
    return {
      sha256: str(r, 'sha256'),
      attemptId: str(r, 'attempt_id') as AttemptId,
      bytes: num(r, 'bytes'),
      validationStatus: str(r, 'validation_status') as ArtifactRecord['validationStatus'],
      recordedAt: str(r, 'recorded_at'),
      ...(optStr(r, 'uri') === undefined ? {} : { uri: str(r, 'uri') }),
      ...(optStr(r, 'mime_type') === undefined ? {} : { mimeType: str(r, 'mime_type') }),
      ...(optStr(r, 'reason') === undefined ? {} : { reason: str(r, 'reason') }),
      ...(optStr(r, 'stored_path') === undefined ? {} : { storedPath: str(r, 'stored_path') }),
    };
  }

  async close(): Promise<void> {
    if (this.#db.isOpen) this.#db.close();
  }
}

function outboxFromRow(r: Row): OutboxRecord {
  return {
    attemptId: str(r, 'attempt_id') as AttemptId,
    taskId: TaskId(str(r, 'task_id')),
    peerId: str(r, 'peer_id') as OutboxRecord['peerId'],
    state: str(r, 'state') as OutboxState,
    requestDigest: str(r, 'request_digest'),
    idempotencyKey: str(r, 'idempotency_key'),
    payload: JSON.parse(str(r, 'payload_json')) as unknown,
    sendCount: num(r, 'send_count'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
    ...(optStr(r, 'remote_task_id') === undefined ? {} : { remoteTaskId: str(r, 'remote_task_id') }),
    ...(optStr(r, 'last_error') === undefined ? {} : { lastError: str(r, 'last_error') }),
  };
}

function statsFromRow(r: Row): ExecutorStats {
  return {
    executorId: str(r, 'peer_id'),
    skill: str(r, 'skill'),
    successCount: num(r, 'success_count'),
    failureCount: num(r, 'failure_count'),
    timeoutCount: num(r, 'timeout_count'),
    cancelCount: num(r, 'cancel_count'),
    artifactFailureCount: num(r, 'artifact_failure_count'),
    totalCostUsd: num(r, 'total_cost_usd'),
    latency: JSON.parse(str(r, 'latency_histogram')) as ExecutorStats['latency'],
  };
}

function constraintError(error: unknown, message: string): unknown {
  if (error instanceof Error && /constraint/i.test(error.message)) return new HarnessError('validation_failed', message);
  return error;
}
