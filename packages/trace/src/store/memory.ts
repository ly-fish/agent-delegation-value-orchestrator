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
  isTerminalPhase,
  type OutboxPatch,
  type OutboxRecord,
  type OutboxState,
  type PeerId,
  type PeerRecord,
  RevisionConflictError,
  systemClock,
  type TaskCommit,
  type TaskId,
  type TaskState,
  type TaskSummary,
  toIso,
} from '@dvo/core';
import { applyOutcome, decisionsOf, emptyStats, identitySanitizer, type Sanitizer, statsKey, validateCommit } from './common.ts';

interface TaskRow {
  state: TaskState;
  events: DomainEvent[];
  updatedAt: string;
}

/**
 * Reference implementation of the store contract, used by tests, evaluations and replays.
 * Behaviour (CAS, uniqueness, outbox transitions, idempotent outcomes) matches SqliteStore;
 * both are exercised by the same contract test suite.
 */
export class InMemoryStore implements HarnessStore {
  readonly #tasks = new Map<TaskId, TaskRow>();
  readonly #eventIds = new Set<string>();
  readonly #clientKeys = new Map<string, TaskId>();
  readonly #outbox = new Map<AttemptId, OutboxRecord>();
  readonly #outcomes = new Set<AttemptId>();
  readonly #stats = new Map<string, ExecutorStats>();
  readonly #peers = new Map<PeerId, PeerRecord>();
  readonly #artifacts = new Map<string, ArtifactRecord>();
  readonly #sanitize: Sanitizer;
  readonly #clock: Clock;

  constructor(options: { sanitize?: Sanitizer; clock?: Clock } = {}) {
    this.#sanitize = options.sanitize ?? identitySanitizer;
    this.#clock = options.clock ?? systemClock;
  }

  async commit(commit: TaskCommit): Promise<void> {
    validateCommit(commit);
    const row = this.#tasks.get(commit.taskId);
    const actual = row?.state.revision ?? 0;
    if (actual !== commit.expectedRevision) throw new RevisionConflictError(commit.taskId, commit.expectedRevision, actual);
    for (const event of commit.events) {
      if (this.#eventIds.has(event.eventId))
        throw new HarnessError('validation_failed', 'duplicate event id', { details: { eventId: event.eventId } });
    }
    const key = commit.state.clientRequestKey;
    if (commit.expectedRevision === 0 && key !== undefined && this.#clientKeys.has(key)) {
      throw new HarnessError('validation_failed', 'duplicate client request key');
    }
    for (const record of commit.outbox ?? []) {
      if (this.#outbox.has(record.attemptId)) throw new HarnessError('validation_failed', 'duplicate outbox record');
    }

    const events = commit.events.map((e) => this.#sanitize(structuredClone(e)) as DomainEvent);
    const state = this.#sanitize(structuredClone(commit.state)) as TaskState;
    for (const event of events) this.#eventIds.add(event.eventId);
    if (commit.expectedRevision === 0 && key !== undefined) this.#clientKeys.set(key, commit.taskId);
    for (const record of commit.outbox ?? []) this.#outbox.set(record.attemptId, this.#sanitize(structuredClone(record)) as OutboxRecord);
    this.#tasks.set(commit.taskId, {
      state,
      events: [...(row?.events ?? []), ...events],
      updatedAt: toIso(this.#clock.now()),
    });
  }

  async load(taskId: TaskId): Promise<TaskState | undefined> {
    const row = this.#tasks.get(taskId);
    return row === undefined ? undefined : structuredClone(row.state);
  }

  async events(taskId: TaskId): Promise<DomainEvent[]> {
    return structuredClone(this.#tasks.get(taskId)?.events ?? []);
  }

  async decisions(taskId: TaskId): Promise<DecisionRecord[]> {
    return decisionsOf(await this.events(taskId));
  }

  async findByClientKey(clientRequestKey: string): Promise<TaskId | undefined> {
    return this.#clientKeys.get(clientRequestKey);
  }

  async listTasks(filter: { nonTerminal?: boolean; limit?: number } = {}): Promise<TaskSummary[]> {
    const rows = [...this.#tasks.values()]
      .filter((row) => filter.nonTerminal !== true || !isTerminalPhase(row.state.phase))
      .sort((a, b) => (a.state.createdAt < b.state.createdAt ? 1 : -1))
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
    return rows.map((row) => ({
      taskId: row.state.taskId,
      phase: row.state.phase,
      revision: row.state.revision,
      classification: row.state.classification,
      createdAt: row.state.createdAt,
      updatedAt: row.updatedAt,
      ...(row.state.clientRequestKey === undefined ? {} : { clientRequestKey: row.state.clientRequestKey }),
    }));
  }

  async getOutbox(attemptId: AttemptId): Promise<OutboxRecord | undefined> {
    const record = this.#outbox.get(attemptId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async transitionOutbox(
    attemptId: AttemptId,
    expected: OutboxState | readonly OutboxState[],
    to: OutboxState,
    patch: OutboxPatch = {},
  ): Promise<OutboxRecord> {
    const record = this.#outbox.get(attemptId);
    if (record === undefined) throw new HarnessError('not_found', 'outbox record not found');
    const allowed: readonly OutboxState[] = typeof expected === 'string' ? [expected] : expected;
    if (!allowed.includes(record.state)) {
      throw new HarnessError('revision_conflict', 'outbox state changed concurrently', {
        retryable: false,
        details: { attemptId, expected: allowed, actual: record.state },
      });
    }
    assertOutboxTransition(record.state, to);
    const next: OutboxRecord = {
      ...record,
      state: to,
      ...(patch.remoteTaskId === undefined ? {} : { remoteTaskId: patch.remoteTaskId }),
      ...(patch.lastError === undefined ? {} : { lastError: String(this.#sanitize(patch.lastError)) }),
      sendCount: record.sendCount + (patch.incrementSendCount === true ? 1 : 0),
      updatedAt: toIso(this.#clock.now()),
    };
    this.#outbox.set(attemptId, next);
    return structuredClone(next);
  }

  async listOutbox(states: readonly OutboxState[]): Promise<OutboxRecord[]> {
    return [...this.#outbox.values()].filter((r) => states.includes(r.state)).map((r) => structuredClone(r));
  }

  async recordOutcome(outcome: ExecutorOutcome): Promise<boolean> {
    if (this.#outcomes.has(outcome.attemptId)) return false;
    this.#outcomes.add(outcome.attemptId);
    const key = statsKey(outcome.executorId, outcome.skill);
    this.#stats.set(key, applyOutcome(this.#stats.get(key) ?? emptyStats(outcome.executorId, outcome.skill), outcome));
    return true;
  }

  async executorStats(): Promise<ExecutorStats[]> {
    return [...this.#stats.values()].map((s) => structuredClone(s));
  }

  async upsertPeer(record: PeerRecord): Promise<void> {
    this.#peers.set(record.peerId, { ...(this.#peers.get(record.peerId) ?? {}), ...record });
  }

  async listPeers(): Promise<PeerRecord[]> {
    return [...this.#peers.values()].map((p) => ({ ...p }));
  }

  async putArtifact(record: ArtifactRecord): Promise<void> {
    this.#artifacts.set(`${record.sha256}:${record.attemptId}`, { ...record });
  }

  async getArtifact(sha256: string): Promise<ArtifactRecord | undefined> {
    for (const record of this.#artifacts.values()) if (record.sha256 === sha256) return { ...record };
    return undefined;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
