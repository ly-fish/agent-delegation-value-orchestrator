import type { DecisionRecord } from './actions.ts';
import type { AttemptResultSummary, AttemptState, AttemptStatus, VerificationState } from './attempt.ts';
import type { Budget } from './budget.ts';
import type { DataClassification } from './classification.ts';
import type { HardnessProfile } from './hardness.ts';
import type { AttemptId, EventId, TaskId, TraceId } from './ids.ts';
import type { PolicyInput } from './policy-input.ts';
import type { FinalOutcome, TaskPhase, VerificationSpec } from './task.ts';

export const EVENT_SCHEMA_VERSION = 1;

interface EventOf<T extends string, P> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  eventId: EventId;
  type: T;
  taskId: TaskId;
  attemptId?: AttemptId;
  traceId: TraceId;
  parentEventId?: EventId;
  occurredAt: string;
  payload: P;
}

export type TaskCreatedEvent = EventOf<
  'task.created',
  {
    userGoal: string;
    classification: DataClassification;
    budget: Budget;
    hardness: HardnessProfile;
    verification?: VerificationSpec;
    requiredSkills: string[];
    allowRemote: boolean;
    successValueUsd: number;
    safeForExploration: boolean;
    clientRequestKey?: string;
    redactionApplied: boolean;
    labels: Record<string, string>;
  }
>;

export type TaskPhaseChangedEvent = EventOf<'task.phase_changed', { from: TaskPhase; to: TaskPhase; reason: string }>;
export type TaskCancelRequestedEvent = EventOf<'task.cancel_requested', { reason: string; requestedBy: string }>;
export type TaskApprovalGrantedEvent = EventOf<
  'task.approval_granted',
  { scope: 'restricted_delegation'; approver: string; reason: string }
>;
export type TaskDegradedEvent = EventOf<'task.degraded', { reason: string }>;
export type TaskFinalizedEvent = EventOf<'task.finalized', { outcome: FinalOutcome }>;

export type DecisionMadeEvent = EventOf<'decision.made', { record: DecisionRecord; input: PolicyInput }>;

export type AttemptCreatedEvent = EventOf<
  'attempt.created',
  Pick<
    AttemptState,
    | 'executorId'
    | 'executorKind'
    | 'peerId'
    | 'purpose'
    | 'decisionIndex'
    | 'deadlineAt'
    | 'idempotencyKey'
    | 'requestedTier'
    | 'skill'
    | 'reservedCostUsd'
    | 'reservedRemoteCalls'
    | 'targetAttemptIds'
  > & { requestDigest?: string; classificationSent: DataClassification }
>;
export type AttemptStatusChangedEvent = EventOf<'attempt.status_changed', { from: AttemptStatus; to: AttemptStatus; reason: string }>;
/** Audit record of a transition that was refused (duplicate, late or out-of-order input). */
export type AttemptTransitionRejectedEvent = EventOf<
  'attempt.transition_rejected',
  { from: AttemptStatus; to: AttemptStatus | 'result'; reason: string }
>;
export type AttemptRemoteSubmittedEvent = EventOf<'attempt.remote_submitted', { remoteTaskId: string; requestDigest: string }>;
export type AttemptSubmissionUnknownEvent = EventOf<'attempt.submission_unknown', { reason: string }>;
export type AttemptResultRecordedEvent = EventOf<'attempt.result_recorded', { result: AttemptResultSummary }>;
export type AttemptLateResultEvent = EventOf<
  'attempt.late_result',
  { terminalStatus: AttemptResultSummary['terminalStatus']; accepted: boolean; reason: string }
>;

export type VerificationRecordedEvent = EventOf<
  'verification.recorded',
  {
    verifierAttemptId: AttemptId;
    targetAttemptId: AttemptId;
    verifierId: string;
    outcome: VerificationState;
    claimVerdicts: Array<{ claimId: string; verdict: 'verified' | 'refuted' | 'inconclusive' }>;
    detail?: string;
  }
>;

export type DomainEvent =
  | TaskCreatedEvent
  | TaskPhaseChangedEvent
  | TaskCancelRequestedEvent
  | TaskApprovalGrantedEvent
  | TaskDegradedEvent
  | TaskFinalizedEvent
  | DecisionMadeEvent
  | AttemptCreatedEvent
  | AttemptStatusChangedEvent
  | AttemptTransitionRejectedEvent
  | AttemptRemoteSubmittedEvent
  | AttemptSubmissionUnknownEvent
  | AttemptResultRecordedEvent
  | AttemptLateResultEvent
  | VerificationRecordedEvent;

export type DomainEventType = DomainEvent['type'];
export type EventOfType<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends DomainEventType> = EventOfType<T>['payload'];
