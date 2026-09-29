import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyEvent,
  AttemptId,
  type DomainEvent,
  type HarnessStore,
  NEUTRAL_HARDNESS,
  PeerId,
  RevisionConflictError,
  TaskId,
  type TaskState,
  TraceId,
} from '@dvo/core';
import { Redactor } from '@dvo/evidence';
import { InMemoryStore, SqliteStore } from '@dvo/trace';
import { SequentialIds } from '@dvo/testkit';

const redactor = new Redactor();
const sanitize = (v: unknown) => redactor.redact(v).value;
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dvo-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(ids = new SequentialIds()) {
  const taskId = TaskId('tsk_contract');
  const traceId = TraceId('c'.repeat(32));
  const ev = (type: string, payload: unknown, attemptId?: string): DomainEvent =>
    ({
      schemaVersion: 1,
      eventId: ids.eventId(),
      type,
      taskId,
      traceId,
      occurredAt: '2026-01-01T00:00:00.000Z',
      ...(attemptId === undefined ? {} : { attemptId: AttemptId(attemptId) }),
      payload,
    }) as DomainEvent;
  const created = ev('task.created', {
    userGoal: 'goal with key sk-' + 'x'.repeat(24),
    classification: 'internal',
    budget: {
      maxCostUsd: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxRemoteCalls: 2,
      maxParallelAttempts: 2,
      deadlineAt: '2026-01-01T00:10:00.000Z',
    },
    hardness: { ...NEUTRAL_HARDNESS },
    requiredSkills: [],
    allowRemote: true,
    successValueUsd: 1,
    safeForExploration: false,
    clientRequestKey: 'client-key-1',
    redactionApplied: false,
    labels: {},
  });
  const attempt = ev(
    'attempt.created',
    {
      executorId: 'peer-a',
      executorKind: 'a2a-peer',
      peerId: 'peer-a',
      purpose: 'delegate',
      decisionIndex: 0,
      deadlineAt: '2026-01-01T00:05:00.000Z',
      idempotencyKey: 'k1',
      requestedTier: 1,
      reservedCostUsd: 0.01,
      reservedRemoteCalls: 1,
      classificationSent: 'internal',
    },
    'att_1',
  );
  return { taskId, ev, created, attempt };
}

async function commitAll(store: HarnessStore, events: DomainEvent[], expectedRevision = 0, prior?: TaskState, outbox = false) {
  let state = prior;
  for (const e of events) state = applyEvent(state, e);
  await store.commit({
    taskId: state!.taskId,
    expectedRevision,
    events,
    state: state!,
    ...(outbox
      ? {
          outbox: [
            {
              attemptId: AttemptId('att_1'),
              taskId: state!.taskId,
              peerId: PeerId('peer-a'),
              state: 'pending' as const,
              requestDigest: 'd',
              idempotencyKey: 'k1',
              payload: { rpcUrl: 'https://x' },
              sendCount: 0,
              createdAt: 'c',
              updatedAt: 'u',
            },
          ],
        }
      : {}),
  });
  return state!;
}

const stores: Array<[string, () => HarnessStore]> = [
  ['InMemoryStore', () => new InMemoryStore({ sanitize })],
  ['SqliteStore', () => new SqliteStore(join(dir, 'dvo.db'), { sanitize })],
];

describe.each(stores)('%s contract', (_name, make) => {
  it('commits atomically with CAS on revision', async () => {
    const store = make();
    const { created, attempt, ev } = fixture();
    const s1 = await commitAll(store, [created]);
    const s2 = await commitAll(store, [attempt], 1, s1, true);
    // A second writer still based on revision 1 loses the race.
    const stale = ev('task.phase_changed', { from: 'created', to: 'assessing', reason: 'stale writer' });
    await expect(commitAll(store, [stale], 1, s1)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await store.load(s2.taskId))!.revision).toBe(2);
    expect((await store.events(s2.taskId)).map((e) => e.type)).toEqual(['task.created', 'attempt.created']);
    await store.close();
  });

  it('never persists secrets (sanitised as a last line of defence)', async () => {
    const store = make();
    const { created } = fixture();
    const s = await commitAll(store, [created]);
    expect(JSON.stringify(await store.events(s.taskId))).not.toContain('xxxxxxxx');
    expect((await store.load(s.taskId))!.userGoal).toContain('[REDACTED:api_key]');
    await store.close();
  });

  it('rejects duplicate event ids and duplicate client keys', async () => {
    const store = make();
    const { created, ev } = fixture(new SequentialIds('a'));
    const s = await commitAll(store, [created]);
    const again = { ...created, taskId: TaskId('tsk_other') } as DomainEvent;
    await expect(commitAll(store, [again])).rejects.toThrow(/duplicate/);
    const phase = ev('task.phase_changed', { from: 'created', to: 'assessing', reason: 'r' });
    await commitAll(store, [phase], 1, s);
    await expect(commitAll(store, [{ ...phase, eventId: phase.eventId }], 2, applyEvent(s, phase))).rejects.toThrow();
    expect(await store.findByClientKey('client-key-1')).toBe(s.taskId);
    await store.close();
  });

  it('drives the outbox through compare-and-set transitions', async () => {
    const store = make();
    const { created, attempt } = fixture();
    const s1 = await commitAll(store, [created]);
    await commitAll(store, [attempt], 1, s1, true);
    const id = AttemptId('att_1');
    expect((await store.getOutbox(id))!.state).toBe('pending');
    await store.transitionOutbox(id, 'pending', 'sending', { incrementSendCount: true });
    await expect(store.transitionOutbox(id, 'pending', 'sending')).rejects.toThrow(/changed concurrently/);
    const submitted = await store.transitionOutbox(id, 'sending', 'submitted', { remoteTaskId: 'r-1' });
    expect(submitted).toMatchObject({ state: 'submitted', remoteTaskId: 'r-1', sendCount: 1 });
    await expect(store.transitionOutbox(id, 'submitted', 'sending')).rejects.toThrow(/illegal outbox transition/);
    expect(await store.listOutbox(['submitted'])).toHaveLength(1);
    await store.close();
  });

  it('records one reliability outcome per attempt', async () => {
    const store = make();
    const outcome = {
      attemptId: AttemptId('att_9'),
      executorId: 'peer-a',
      skill: 'general',
      success: true,
      terminalStatus: 'completed' as const,
      latencyMs: 120,
      costUsd: 0.01,
      artifactFailure: false,
      at: 'now',
    };
    expect(await store.recordOutcome(outcome)).toBe(true);
    expect(await store.recordOutcome(outcome)).toBe(false);
    await store.recordOutcome({ ...outcome, attemptId: AttemptId('att_10'), success: false, terminalStatus: 'timed_out' });
    const [stats] = await store.executorStats();
    expect(stats).toMatchObject({ successCount: 1, failureCount: 1, timeoutCount: 1, totalCostUsd: 0.02 });
    expect(stats!.latency.count).toBe(2);
    await store.close();
  });

  it('lists non-terminal tasks and keeps peers and artifacts', async () => {
    const store = make();
    const { created } = fixture();
    await commitAll(store, [created]);
    expect(await store.listTasks({ nonTerminal: true })).toHaveLength(1);
    await store.upsertPeer({ peerId: PeerId('peer-a'), trustTier: 'internal', circuit: 'open', cardDigest: 'abc' });
    await store.upsertPeer({ peerId: PeerId('peer-a'), trustTier: 'internal', circuit: 'closed' });
    expect(await store.listPeers()).toMatchObject([{ peerId: 'peer-a', circuit: 'closed', cardDigest: 'abc' }]);
    await store.putArtifact({
      sha256: 'f'.repeat(64),
      attemptId: AttemptId('att_1'),
      bytes: 10,
      validationStatus: 'quarantined',
      recordedAt: 'now',
    });
    expect((await store.getArtifact('f'.repeat(64)))!.validationStatus).toBe('quarantined');
    await store.close();
  });
});

describe('SqliteStore durability', () => {
  it('survives a reopen with schema version, events and outbox intact', async () => {
    const path = join(dir, 'durable.db');
    const first = new SqliteStore(path);
    const { created, attempt } = fixture();
    const s1 = await commitAll(first, [created]);
    await commitAll(first, [attempt], 1, s1, true);
    await first.close();
    const second = new SqliteStore(path);
    expect(second.schemaVersion).toBe(1);
    expect((await second.load(s1.taskId))!.revision).toBe(2);
    expect((await second.listOutbox(['pending']))[0]!.payload).toEqual({ rpcUrl: 'https://x' });
    await second.close();
  });
});
