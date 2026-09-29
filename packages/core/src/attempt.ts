import type { ActionKind } from './actions.ts';
import { IllegalTransitionError } from './errors.ts';
import type { EvidenceEnvelope, EvidenceTier } from './evidence.ts';
import type { Diagnostic, ExecutorKind, RuntimeInfo, TerminalStatus, Usage } from './execution.ts';
import type { AttemptId, PeerId } from './ids.ts';

/**
 * Attempt lifecycle (design §10.1).
 *
 *   queued ─▶ running ─▶ awaiting_peer ─▶ verifying ─▶ succeeded | failed
 *                │             │
 *                └─────────────┴──▶ cancel_requested ─▶ cancelled
 *                                                   └─▶ succeeded (late result accepted)
 *
 * Additions to the design diagram, both conservative: `queued → cancelled` (cancelled before
 * it ever ran) and `awaiting_peer → failed` (infrastructure failure with no peer result, such
 * as an unknown submission to a non-de-duplicating peer).
 */
export const ATTEMPT_STATUSES = [
  'queued',
  'running',
  'awaiting_peer',
  'verifying',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['awaiting_peer', 'verifying', 'cancel_requested', 'failed'],
  awaiting_peer: ['verifying', 'cancel_requested', 'failed'],
  verifying: ['succeeded', 'failed'],
  cancel_requested: ['cancelled', 'succeeded'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status);
}

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransitionAttempt(from, to)) throw new IllegalTransitionError('attempt', from, to);
}

/** Shortest legal path between two statuses, used to walk an attempt forward one step at a time. */
export function attemptPath(from: AttemptStatus, to: AttemptStatus): AttemptStatus[] | undefined {
  if (from === to) return [];
  const queue: Array<[AttemptStatus, AttemptStatus[]]> = [[from, []]];
  const seen = new Set<AttemptStatus>([from]);
  while (queue.length > 0) {
    const [status, path] = queue.shift()!;
    for (const next of ATTEMPT_TRANSITIONS[status]) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push([next, nextPath]);
    }
  }
  return undefined;
}

/** Verification standing of an attempt's output, set only by local verifier events. */
export type VerificationState = 'unverified' | 'verified' | 'refuted' | 'inconclusive';

export type InjectionRisk = 'low' | 'medium' | 'high';

export interface AttemptResultSummary {
  terminalStatus: TerminalStatus;
  usage: Usage;
  diagnostics: Diagnostic[];
  /** Sanitised by the evidence gateway (redacted, statuses demoted, unknown fields dropped). */
  output?: EvidenceEnvelope;
  /** Self-reported confidence shrunk towards the executor's observed reliability. */
  calibratedConfidence: number;
  /** High injection risk: may reach isolated verifiers only, never a model prompt. */
  quarantined: boolean;
  injectionRisk: InjectionRisk;
  issues: string[];
  late: boolean;
  runtime?: RuntimeInfo;
  receivedAt: string;
}

export interface AttemptState {
  attemptId: AttemptId;
  executorId: string;
  executorKind: ExecutorKind;
  peerId?: PeerId;
  purpose: Exclude<ActionKind, 'stop'>;
  decisionIndex: number;
  status: AttemptStatus;
  createdAt: string;
  deadlineAt: string;
  idempotencyKey: string;
  requestedTier: EvidenceTier;
  skill?: string;
  reservedCostUsd: number;
  reservedRemoteCalls: number;
  /** Cost reservation released and converted into committed spend. */
  costSettled: boolean;
  /** Remote-call reservation released (charged if the request may have left the process). */
  remoteCallSettled: boolean;
  remoteTaskId?: string;
  submissionUnknown?: boolean;
  /** For verifier attempts: the attempts whose outputs are being checked. */
  targetAttemptIds?: AttemptId[];
  result?: AttemptResultSummary;
  verification: VerificationState;
  verifiedBy?: AttemptId;
  cancelRequested: boolean;
}

/** An attempt whose output may be offered as the task's answer. */
export function isCandidateResult(attempt: AttemptState): boolean {
  return (
    attempt.executorKind !== 'verifier' &&
    attempt.status === 'succeeded' &&
    attempt.result?.terminalStatus === 'completed' &&
    attempt.result.output !== undefined &&
    attempt.verification !== 'refuted'
  );
}
