import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATUSES,
  assertAttemptTransition,
  assertOutboxTransition,
  attemptPath,
  canTransitionAttempt,
  canTransitionTask,
  IllegalTransitionError,
  isTerminalAttemptStatus,
  isTerminalPhase,
  TASK_PHASES,
} from '@dvo/core';

describe('attempt state machine (design §10.1)', () => {
  it('follows the documented happy paths', () => {
    expect(attemptPath('queued', 'succeeded')).toEqual(['running', 'verifying', 'succeeded']);
    expect(attemptPath('running', 'cancelled')).toEqual(['cancel_requested', 'cancelled']);
    expect(canTransitionAttempt('awaiting_peer', 'verifying')).toBe(true);
    expect(canTransitionAttempt('cancel_requested', 'succeeded')).toBe(true); // late result accepted
  });

  it('never leaves a terminal status', () => {
    for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isTerminalAttemptStatus(terminal)).toBe(true);
      for (const to of ATTEMPT_STATUSES) expect(canTransitionAttempt(terminal, to)).toBe(false);
    }
  });

  it('rejects illegal transitions with a typed error', () => {
    expect(() => assertAttemptTransition('succeeded', 'running')).toThrow(IllegalTransitionError);
    expect(() => assertAttemptTransition('verifying', 'cancel_requested')).toThrow(/illegal attempt transition/);
    expect(attemptPath('succeeded', 'running')).toBeUndefined();
  });
});

describe('task phases', () => {
  it('terminal phases are absorbing', () => {
    for (const phase of ['succeeded', 'failed', 'cancelled', 'expired'] as const) {
      expect(isTerminalPhase(phase)).toBe(true);
      for (const to of TASK_PHASES) expect(canTransitionTask(phase, to)).toBe(false);
    }
  });

  it('a cancel request can only end cancelled, failed or expired', () => {
    expect(canTransitionTask('cancel_requested', 'succeeded')).toBe(false);
    expect(canTransitionTask('cancel_requested', 'cancelled')).toBe(true);
    expect(canTransitionTask('running', 'degraded')).toBe(true);
  });
});

describe('outbox state machine', () => {
  it('allows resending only from pending or submission_unknown', () => {
    expect(() => assertOutboxTransition('pending', 'sending')).not.toThrow();
    expect(() => assertOutboxTransition('submission_unknown', 'sending')).not.toThrow();
    expect(() => assertOutboxTransition('submitted', 'sending')).toThrow(IllegalTransitionError);
    expect(() => assertOutboxTransition('abandoned', 'pending')).toThrow(IllegalTransitionError);
  });
});
