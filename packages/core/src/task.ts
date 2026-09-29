import type { AttemptState } from './attempt.ts';
import type { Budget, Spend } from './budget.ts';
import type { DataClassification } from './classification.ts';
import { IllegalTransitionError } from './errors.ts';
import type { HardnessHints, HardnessProfile } from './hardness.ts';
import type { AttemptId, TaskId, TraceId } from './ids.ts';

/** A locally configured verification recipe. Peers can never supply or alter one. */
export interface VerificationSpec {
  verifierId: string;
  params?: Record<string, unknown>;
}

/** Caller-facing task submission (validated at ingress). */
export interface TaskSpec {
  goal: string;
  classification?: DataClassification;
  budget?: Partial<Omit<Budget, 'deadlineAt'>> & { deadlineMs?: number };
  verification?: VerificationSpec;
  requiredSkills?: string[];
  allowRemote?: boolean;
  /** Utility of a correct answer, in USD-equivalent; the policy weighs gains against cost with it. */
  successValueUsd?: number;
  hints?: HardnessHints;
  /** Opt-in for randomised exploration (only honoured for public, verifiable tasks). */
  safeForExploration?: boolean;
  labels?: Record<string, string>;
}

export const TASK_PHASES = [
  'created',
  'assessing',
  'running',
  'awaiting_peer',
  'verifying',
  'degraded',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

const ACTIVE: readonly TaskPhase[] = ['assessing', 'running', 'awaiting_peer', 'verifying', 'degraded'];
const TERMINAL: readonly TaskPhase[] = ['succeeded', 'failed', 'cancelled', 'expired'];

const TASK_TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = {
  created: ['assessing', 'cancel_requested', 'failed', 'cancelled'],
  assessing: [...ACTIVE.filter((p) => p !== 'assessing'), 'cancel_requested', ...TERMINAL],
  running: [...ACTIVE.filter((p) => p !== 'running'), 'cancel_requested', ...TERMINAL],
  awaiting_peer: [...ACTIVE.filter((p) => p !== 'awaiting_peer'), 'cancel_requested', ...TERMINAL],
  verifying: [...ACTIVE.filter((p) => p !== 'verifying'), 'cancel_requested', ...TERMINAL],
  degraded: [...ACTIVE.filter((p) => p !== 'degraded'), 'cancel_requested', ...TERMINAL],
  cancel_requested: ['cancelled', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL.includes(phase);
}

export function canTransitionTask(from: TaskPhase, to: TaskPhase): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskPhase, to: TaskPhase): void {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError('task', from, to);
}

/** Verification standing of a final answer (design §16.1). */
export type FinalVerificationStatus = 'verified' | 'supported' | 'proposed' | 'unverified';

export type TerminalTaskPhase = 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface FinalOutcome {
  status: TerminalTaskPhase;
  verificationStatus: FinalVerificationStatus;
  finalAttemptId?: AttemptId;
  reason: string;
  answer?: { claimId: string; statement: string };
  finalizedAt: string;
}

export interface TaskState {
  taskId: TaskId;
  traceId: TraceId;
  phase: TaskPhase;
  /** Number of events applied; the CAS token for commits. */
  revision: number;
  /** Redacted, minimal task description: the only form of the goal that is ever stored. */
  userGoal: string;
  classification: DataClassification;
  budget: Budget;
  /** Committed spend. */
  spent: Spend;
  /** Estimates held by in-flight attempts (released when they settle). */
  reserved: Spend;
  createdAt: string;
  hardnessProfile: HardnessProfile;
  verification?: VerificationSpec;
  requiredSkills: string[];
  allowRemote: boolean;
  successValueUsd: number;
  safeForExploration: boolean;
  approvals: { restrictedDelegation: boolean };
  attempts: Record<string, AttemptState>;
  attemptOrder: AttemptId[];
  activeAttempts: AttemptId[];
  decisionCount: number;
  cancelRequested: boolean;
  degradedReasons: string[];
  finalAttemptId?: AttemptId;
  outcome?: FinalOutcome;
  clientRequestKey?: string;
  labels: Record<string, string>;
}

export function attemptsOf(state: TaskState): AttemptState[] {
  return state.attemptOrder.map((id) => state.attempts[id]).filter((a): a is AttemptState => a !== undefined);
}
