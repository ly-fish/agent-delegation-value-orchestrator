import { assertAttemptTransition, isTerminalAttemptStatus, type AttemptState } from './attempt.ts';
import { addSpend, subtractSpend, ZERO_SPEND } from './budget.ts';
import { HarnessError } from './errors.ts';
import type { DomainEvent, TaskCreatedEvent } from './events.ts';
import type { AttemptId } from './ids.ts';
import { assertTaskTransition, type TaskState } from './task.ts';

/**
 * The task projection is a pure left fold over the task's event log. The live engine,
 * the SQLite projection tables and the replayer all use this one function, so "what the
 * system believed" can always be rebuilt from the append-only log (design §10.3, §11.3).
 */
export function projectTask(events: readonly DomainEvent[]): TaskState | undefined {
  let state: TaskState | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state;
}

export function applyEvent(state: TaskState | undefined, event: DomainEvent): TaskState {
  if (event.type === 'task.created') {
    if (state !== undefined) throw corrupt(event, 'task.created applied twice');
    return initialState(event);
  }
  if (state === undefined) throw corrupt(event, `${event.type} before task.created`);
  if (event.taskId !== state.taskId) throw corrupt(event, 'event belongs to another task');
  const next = reduce(state, event);
  return { ...next, revision: state.revision + 1 };
}

function initialState(event: TaskCreatedEvent): TaskState {
  const p = event.payload;
  return {
    taskId: event.taskId,
    traceId: event.traceId,
    phase: 'created',
    revision: 1,
    userGoal: p.userGoal,
    classification: p.classification,
    budget: p.budget,
    spent: { ...ZERO_SPEND },
    reserved: { ...ZERO_SPEND },
    createdAt: event.occurredAt,
    hardnessProfile: p.hardness,
    ...(p.verification === undefined ? {} : { verification: p.verification }),
    requiredSkills: p.requiredSkills,
    allowRemote: p.allowRemote,
    successValueUsd: p.successValueUsd,
    safeForExploration: p.safeForExploration,
    approvals: { restrictedDelegation: false },
    attempts: {},
    attemptOrder: [],
    activeAttempts: [],
    decisionCount: 0,
    cancelRequested: false,
    degradedReasons: [],
    ...(p.clientRequestKey === undefined ? {} : { clientRequestKey: p.clientRequestKey }),
    labels: p.labels,
  };
}

function reduce(state: TaskState, event: Exclude<DomainEvent, TaskCreatedEvent>): TaskState {
  switch (event.type) {
    case 'task.phase_changed':
      if (event.payload.from !== state.phase) throw corrupt(event, `phase is ${state.phase}, event says ${event.payload.from}`);
      assertTaskTransition(event.payload.from, event.payload.to);
      return { ...state, phase: event.payload.to };

    case 'task.cancel_requested':
      return { ...state, cancelRequested: true };

    case 'task.approval_granted':
      return { ...state, approvals: { ...state.approvals, restrictedDelegation: true } };

    case 'task.degraded':
      return state.degradedReasons.includes(event.payload.reason)
        ? state
        : { ...state, degradedReasons: [...state.degradedReasons, event.payload.reason] };

    case 'task.finalized': {
      const { outcome } = event.payload;
      return {
        ...state,
        outcome,
        ...(outcome.finalAttemptId === undefined ? {} : { finalAttemptId: outcome.finalAttemptId }),
      };
    }

    case 'decision.made':
      return { ...state, decisionCount: Math.max(state.decisionCount, event.payload.record.decisionIndex + 1) };

    case 'attempt.created': {
      const id = requireAttemptId(event);
      if (state.attempts[id] !== undefined) throw corrupt(event, 'attempt created twice');
      const p = event.payload;
      const attempt: AttemptState = {
        attemptId: id,
        executorId: p.executorId,
        executorKind: p.executorKind,
        ...(p.peerId === undefined ? {} : { peerId: p.peerId }),
        purpose: p.purpose,
        decisionIndex: p.decisionIndex,
        status: 'queued',
        createdAt: event.occurredAt,
        deadlineAt: p.deadlineAt,
        idempotencyKey: p.idempotencyKey,
        requestedTier: p.requestedTier,
        ...(p.skill === undefined ? {} : { skill: p.skill }),
        reservedCostUsd: p.reservedCostUsd,
        reservedRemoteCalls: p.reservedRemoteCalls,
        costSettled: false,
        remoteCallSettled: p.reservedRemoteCalls === 0,
        ...(p.targetAttemptIds === undefined ? {} : { targetAttemptIds: p.targetAttemptIds }),
        verification: 'unverified',
        cancelRequested: false,
      };
      return {
        ...state,
        attempts: { ...state.attempts, [id]: attempt },
        attemptOrder: [...state.attemptOrder, id],
        activeAttempts: [...state.activeAttempts, id],
        reserved: addSpend(state.reserved, { costUsd: p.reservedCostUsd, remoteCalls: p.reservedRemoteCalls }),
      };
    }

    case 'attempt.status_changed': {
      const attempt = requireAttempt(state, event);
      const { from, to } = event.payload;
      if (from !== attempt.status) throw corrupt(event, `attempt is ${attempt.status}, event says ${from}`);
      assertAttemptTransition(from, to);
      let next: TaskState = withAttempt(state, {
        ...attempt,
        status: to,
        cancelRequested: attempt.cancelRequested || to === 'cancel_requested',
      });
      if (isTerminalAttemptStatus(to)) next = settleTerminal(next, next.attempts[attempt.attemptId]!);
      return next;
    }

    case 'attempt.remote_submitted': {
      const attempt = requireAttempt(state, event);
      return chargeRemoteCall(withAttempt(state, { ...attempt, remoteTaskId: event.payload.remoteTaskId }), attempt.attemptId);
    }

    case 'attempt.submission_unknown': {
      const attempt = requireAttempt(state, event);
      // The request may have reached the peer, so it counts against the remote-call budget.
      return chargeRemoteCall(withAttempt(state, { ...attempt, submissionUnknown: true }), attempt.attemptId);
    }

    case 'attempt.result_recorded': {
      const attempt = requireAttempt(state, event);
      if (attempt.result !== undefined) throw corrupt(event, 'result recorded twice');
      const { result } = event.payload;
      const cost = result.usage.costUsd ?? attempt.reservedCostUsd;
      return {
        ...withAttempt(state, { ...attempt, result, costSettled: true }),
        spent: addSpend(state.spent, {
          costUsd: cost,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        }),
        reserved: attempt.costSettled ? state.reserved : subtractSpend(state.reserved, { costUsd: attempt.reservedCostUsd }),
      };
    }

    case 'verification.recorded': {
      const target = state.attempts[event.payload.targetAttemptId];
      if (target === undefined) throw corrupt(event, 'verification of unknown attempt');
      return withAttempt(state, {
        ...target,
        verification: event.payload.outcome,
        verifiedBy: event.payload.verifierAttemptId,
      });
    }

    case 'attempt.transition_rejected':
    case 'attempt.late_result':
      // Audit-only: recorded so the log explains what was ignored, never changes state.
      return state;
  }
}

/** Releases whatever an attempt still holds once it is terminal. Unreported cost is charged at its estimate. */
function settleTerminal(state: TaskState, attempt: AttemptState): TaskState {
  let next = state;
  let updated = attempt;
  if (!attempt.costSettled) {
    next = {
      ...next,
      spent: addSpend(next.spent, { costUsd: attempt.reservedCostUsd }),
      reserved: subtractSpend(next.reserved, { costUsd: attempt.reservedCostUsd }),
    };
    updated = { ...updated, costSettled: true };
  }
  if (!attempt.remoteCallSettled) {
    // Never left the process (no submission event): release without charging.
    next = { ...next, reserved: subtractSpend(next.reserved, { remoteCalls: attempt.reservedRemoteCalls }) };
    updated = { ...updated, remoteCallSettled: true };
  }
  next = withAttempt(next, updated);
  return { ...next, activeAttempts: next.activeAttempts.filter((id) => id !== attempt.attemptId) };
}

function chargeRemoteCall(state: TaskState, attemptId: AttemptId): TaskState {
  const attempt = state.attempts[attemptId]!;
  if (attempt.remoteCallSettled) return state;
  return {
    ...withAttempt(state, { ...attempt, remoteCallSettled: true }),
    spent: addSpend(state.spent, { remoteCalls: attempt.reservedRemoteCalls }),
    reserved: subtractSpend(state.reserved, { remoteCalls: attempt.reservedRemoteCalls }),
  };
}

function withAttempt(state: TaskState, attempt: AttemptState): TaskState {
  return { ...state, attempts: { ...state.attempts, [attempt.attemptId]: attempt } };
}

function requireAttemptId(event: DomainEvent): AttemptId {
  if (event.attemptId === undefined) throw corrupt(event, 'attempt event without attemptId');
  return event.attemptId;
}

function requireAttempt(state: TaskState, event: DomainEvent): AttemptState {
  const attempt = state.attempts[requireAttemptId(event)];
  if (attempt === undefined) throw corrupt(event, 'event for unknown attempt');
  return attempt;
}

function corrupt(event: DomainEvent, reason: string): HarnessError {
  return new HarnessError('internal', `corrupt event log: ${reason}`, {
    details: { eventId: event.eventId, type: event.type, taskId: event.taskId },
  });
}
