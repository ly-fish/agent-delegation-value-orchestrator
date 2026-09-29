import { describe, expect, it } from 'vitest';
import { applyEvent, AttemptId, type DomainEvent, EventId, NEUTRAL_HARDNESS, projectTask, TaskId, TraceId } from '@dvo/core';

const taskId = TaskId('tsk_1');
const traceId = TraceId('a'.repeat(32));
let n = 0;
const base = (attemptId?: string) => ({
  schemaVersion: 1 as const,
  eventId: EventId(`evt_${++n}`),
  taskId,
  traceId,
  occurredAt: '2026-01-01T00:00:00.000Z',
  ...(attemptId === undefined ? {} : { attemptId: AttemptId(attemptId) }),
});

const created: DomainEvent = {
  ...base(),
  type: 'task.created',
  payload: {
    userGoal: 'g',
    classification: 'internal',
    budget: {
      maxCostUsd: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxRemoteCalls: 3,
      maxParallelAttempts: 2,
      deadlineAt: '2026-01-01T00:10:00.000Z',
    },
    hardness: { ...NEUTRAL_HARDNESS },
    requiredSkills: [],
    allowRemote: true,
    successValueUsd: 1,
    safeForExploration: false,
    redactionApplied: false,
    labels: {},
  },
};

function attemptCreated(id: string, cost: number, remote: number): DomainEvent {
  return {
    ...base(id),
    type: 'attempt.created',
    payload: {
      executorId: remote > 0 ? 'peer-a' : 'dsh-local',
      executorKind: remote > 0 ? 'a2a-peer' : 'dsh-local',
      purpose: remote > 0 ? 'delegate' : 'continue_local',
      decisionIndex: 0,
      deadlineAt: '2026-01-01T00:05:00.000Z',
      idempotencyKey: `k-${id}`,
      requestedTier: 1,
      reservedCostUsd: cost,
      reservedRemoteCalls: remote,
      classificationSent: 'internal',
    },
  };
}

const status = (id: string, from: string, to: string): DomainEvent =>
  ({ ...base(id), type: 'attempt.status_changed', payload: { from, to, reason: 'test' } }) as DomainEvent;

describe('task projection (event-sourced fold)', () => {
  it('reserves on creation and converts reservations into spend on settlement', () => {
    const events: DomainEvent[] = [
      created,
      attemptCreated('att_1', 0.2, 0),
      status('att_1', 'queued', 'running'),
      status('att_1', 'running', 'verifying'),
      {
        ...base('att_1'),
        type: 'attempt.result_recorded',
        payload: {
          result: {
            terminalStatus: 'completed',
            usage: { elapsedMs: 10, costUsd: 0.05, inputTokens: 100, outputTokens: 20 },
            diagnostics: [],
            calibratedConfidence: 0.7,
            quarantined: false,
            injectionRisk: 'low',
            issues: [],
            late: false,
            receivedAt: '2026-01-01T00:00:01.000Z',
          },
        },
      },
      status('att_1', 'verifying', 'succeeded'),
    ];
    const state = projectTask(events)!;
    expect(state.revision).toBe(events.length);
    expect(state.spent.costUsd).toBeCloseTo(0.05);
    expect(state.reserved.costUsd).toBe(0);
    expect(state.activeAttempts).toEqual([]);
    expect(state.spent.inputTokens).toBe(100);
  });

  it('charges a remote call only once the request may have left the process', () => {
    let state = projectTask([created, attemptCreated('att_2', 0.01, 1)])!;
    expect(state.reserved.remoteCalls).toBe(1);
    expect(state.spent.remoteCalls).toBe(0);
    state = applyEvent(state, status('att_2', 'queued', 'failed')); // never sent (e.g. circuit open)
    expect(state.reserved.remoteCalls).toBe(0);
    expect(state.spent.remoteCalls).toBe(0);
    // Unknown cost is charged conservatively at its estimate.
    expect(state.spent.costUsd).toBeCloseTo(0.01);

    let other = projectTask([created, attemptCreated('att_3', 0.01, 1), status('att_3', 'queued', 'running')])!;
    other = applyEvent(other, { ...base('att_3'), type: 'attempt.submission_unknown', payload: { reason: 'reset' } });
    expect(other.spent.remoteCalls).toBe(1);
  });

  it('refuses a corrupt log instead of guessing', () => {
    expect(() => projectTask([attemptCreated('att_x', 0, 0)])).toThrow(/before task.created/);
    expect(() => projectTask([created, attemptCreated('att_4', 0, 0), status('att_4', 'running', 'verifying')])).toThrow(
      /attempt is queued/,
    );
    expect(() => projectTask([created, attemptCreated('att_5', 0, 0), status('att_5', 'queued', 'succeeded')])).toThrow(
      /illegal attempt transition/,
    );
  });

  it('audit-only events never change state', () => {
    const before = projectTask([created, attemptCreated('att_6', 0, 0)])!;
    const after = applyEvent(before, {
      ...base('att_6'),
      type: 'attempt.transition_rejected',
      payload: { from: 'queued', to: 'result', reason: 'dup' },
    });
    expect({ ...after, revision: before.revision }).toEqual(before);
  });
});
