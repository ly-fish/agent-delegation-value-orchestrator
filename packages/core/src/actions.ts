import type { Correlation } from './correlation.ts';
import type { EvidenceTier } from './evidence.ts';
import type { AttemptId, PeerId } from './ids.ts';

export type StopReason = 'budget' | 'deadline' | 'sufficient_evidence' | 'unsafe';

/** The DVO action space (design §5.4). */
export type OrchestrationAction =
  | { kind: 'continue_local' }
  | { kind: 'delegate'; peerId: PeerId; evidenceTier: EvidenceTier }
  | { kind: 'parallel'; peerIds: PeerId[]; evidenceTier: EvidenceTier }
  | { kind: 'verify'; verifierId: string; targetAttemptIds: AttemptId[] }
  | { kind: 'request_evidence'; attemptId: AttemptId; nextTier: 1 | 2 }
  | { kind: 'stop'; reason: StopReason };

export type ActionKind = OrchestrationAction['kind'];

/** Why a candidate action was not eligible. Kept on every decision for audit and replay. */
export type BlockReason =
  | 'deadline_window'
  | 'budget_cost'
  | 'budget_remote_calls'
  | 'budget_tokens'
  | 'max_parallel'
  | 'remote_disallowed'
  | 'classification'
  | 'approval_required'
  | 'circuit_open'
  | 'skill_mismatch'
  | 'peer_unavailable'
  | 'executor_busy'
  | 'latency_exceeds_deadline'
  | 'not_decomposable'
  | 'insufficient_peers'
  | 'local_unavailable'
  | 'local_attempts_exhausted'
  | 'peer_attempts_exhausted'
  | 'verifier_unavailable'
  | 'nothing_to_verify'
  | 'tier_unsupported'
  | 'no_conflict'
  | 'not_worth_cost';

export interface CandidateAction {
  action: OrchestrationAction;
  /** Expected utility gain in USD-equivalent (point estimate). */
  estimatedGain: number;
  /** Gain computed from lower confidence bounds of the reliabilities involved. */
  lowerConfidenceBound: number;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  /** Penalty for trust tier, half-open circuits and similar risks, in USD-equivalent. */
  riskPenalty: number;
  /** lowerConfidenceBound - estimatedCostUsd - latency cost - riskPenalty. */
  netValue: number;
  blockedBy?: BlockReason[];
}

/** Persisted for every decision: the basis of replay, audit and off-policy learning. */
export interface DecisionRecord extends Correlation {
  stateRevision: number;
  decisionIndex: number;
  candidateActions: CandidateAction[];
  selected: OrchestrationAction;
  policyVersion: string;
  decisionReason: string;
  /** Probability with which the logging policy selected `selected` (1 for deterministic choices). */
  propensity: number;
  /** True when `selected` came from randomised exploration rather than the greedy rule. */
  explored: boolean;
  features: Record<string, number>;
}

export function describeAction(action: OrchestrationAction): string {
  switch (action.kind) {
    case 'continue_local':
      return 'continue_local';
    case 'delegate':
      return `delegate(${action.peerId}, tier ${action.evidenceTier})`;
    case 'parallel':
      return `parallel(${action.peerIds.join(', ')}, tier ${action.evidenceTier})`;
    case 'verify':
      return `verify(${action.verifierId})`;
    case 'request_evidence':
      return `request_evidence(${action.attemptId}, tier ${action.nextTier})`;
    case 'stop':
      return `stop(${action.reason})`;
  }
}
