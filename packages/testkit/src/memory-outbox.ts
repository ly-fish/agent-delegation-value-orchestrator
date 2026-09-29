import {
  assertOutboxTransition,
  type AttemptId,
  HarnessError,
  type OutboxPatch,
  type OutboxRecord,
  type OutboxRepository,
  type OutboxState,
} from '@dvo/core';

/** Stand-alone outbox ledger for bridge tests that do not need a whole task store. */
export class MemoryOutbox implements OutboxRepository {
  readonly records = new Map<AttemptId, OutboxRecord>();
  readonly transitions: Array<{ attemptId: AttemptId; from: OutboxState; to: OutboxState }> = [];

  insert(record: OutboxRecord): void {
    this.records.set(record.attemptId, structuredClone(record));
  }

  async getOutbox(attemptId: AttemptId): Promise<OutboxRecord | undefined> {
    const record = this.records.get(attemptId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async transitionOutbox(
    attemptId: AttemptId,
    expected: OutboxState | readonly OutboxState[],
    to: OutboxState,
    patch: OutboxPatch = {},
  ): Promise<OutboxRecord> {
    const record = this.records.get(attemptId);
    if (record === undefined) throw new HarnessError('not_found', 'outbox record not found');
    const allowed: readonly OutboxState[] = typeof expected === 'string' ? [expected] : expected;
    if (!allowed.includes(record.state))
      throw new HarnessError('revision_conflict', `outbox is ${record.state}, expected ${allowed.join('|')}`);
    assertOutboxTransition(record.state, to);
    this.transitions.push({ attemptId, from: record.state, to });
    const next: OutboxRecord = {
      ...record,
      state: to,
      ...(patch.remoteTaskId === undefined ? {} : { remoteTaskId: patch.remoteTaskId }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
      sendCount: record.sendCount + (patch.incrementSendCount === true ? 1 : 0),
    };
    this.records.set(attemptId, next);
    return structuredClone(next);
  }

  async listOutbox(states: readonly OutboxState[]): Promise<OutboxRecord[]> {
    return [...this.records.values()].filter((r) => states.includes(r.state)).map((r) => structuredClone(r));
  }
}
