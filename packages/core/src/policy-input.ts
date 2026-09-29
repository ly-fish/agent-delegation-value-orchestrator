import type { CandidateAction, OrchestrationAction } from './actions.ts';
import type { InjectionRisk, VerificationState } from './attempt.ts';
import type { Budget, Spend } from './budget.ts';
import type { DataClassification, TrustTier } from './classification.ts';
import type { EvidenceTier } from './evidence.ts';
import type { ExecutorKind, TerminalStatus } from './execution.ts';
import type { HardnessProfile } from './hardness.ts';
import type { AttemptId, PeerId, TaskId } from './ids.ts';

/** Posterior summary of an executor's success rate on a skill. */
export interface ReliabilityEstimate {
  mean: number;
  /** One-sided lower confidence bound; the policy gates escalation on this, not the mean. */
  lcb: number;
  /** Number of observed outcomes behind the estimate (0 = prior only). */
  n: number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface PolicyResultView {
  attemptId: AttemptId;
  executorId: string;
  executorKind: ExecutorKind;
  peerId?: PeerId;
  terminalStatus: TerminalStatus;
  calibratedConfidence: number;
  verification: VerificationState;
  quarantined: boolean;
  injectionRisk: InjectionRisk;
  tier: EvidenceTier;
  /**
   * Digest of the normalised statement per claim id. The policy compares answers for
   * conflicts without ever seeing their text, which keeps decision inputs non-sensitive.
   */
  claimDigests: Record<string, string>;
}

export interface PolicyPeerView {
  peerId: PeerId;
  skills: readonly string[];
  trustTier: TrustTier;
  circuit: CircuitState;
  available: boolean;
  reliability: ReliabilityEstimate;
  estCostUsd: number;
  estLatencyMs: number;
  maxEvidenceTier: EvidenceTier;
  attemptsSoFar: number;
  /** Attempts on this peer currently in flight. */
  active: number;
  allowRestricted: boolean;
}

export interface PolicyLocalView {
  executorId: string;
  available: boolean;
  reliability: ReliabilityEstimate;
  estCostUsd: number;
  estLatencyMs: number;
  attemptsSoFar: number;
  failedAttempts: number;
  /** Local attempts currently in flight. */
  active: number;
}

export interface PolicyVerifierView {
  id: string;
  deterministic: boolean;
  available: boolean;
  /** Verification attempts currently in flight. */
  active?: number;
}

/**
 * Everything a policy may look at, and nothing else. Policies are pure functions of this
 * value, which is persisted with every decision so any decision can be replayed exactly.
 */
export interface PolicyInput {
  schemaVersion: 1;
  taskId: TaskId;
  decisionIndex: number;
  nowMs: number;
  deadlineMs: number;
  remainingMs: number;
  classification: DataClassification;
  allowRemote: boolean;
  restrictedDelegationApproved: boolean;
  requiredSkills: readonly string[];
  successValueUsd: number;
  safeForExploration: boolean;
  hardness: HardnessProfile;
  budget: Budget;
  spent: Spend;
  reserved: Spend;
  activeAttempts: number;
  verifierId?: string;
  results: PolicyResultView[];
  local?: PolicyLocalView;
  peers: PolicyPeerView[];
  verifiers: PolicyVerifierView[];
}

export interface PolicyDecision {
  selected: OrchestrationAction;
  candidates: CandidateAction[];
  reason: string;
  propensity: number;
  explored: boolean;
  features: Record<string, number>;
}

export interface PolicyEngine {
  readonly version: string;
  decide(input: PolicyInput): PolicyDecision;
}
