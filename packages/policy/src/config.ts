import type { TrustTier } from '@dvo/core';

export interface ExplorationConfig {
  /** Randomised exploration for off-policy learning (design §7.2). Off by default. */
  enabled: boolean;
  epsilon: number;
  seed: number;
}

export interface PolicyConfig {
  version: string;
  /** No escalation (delegate/parallel/request_evidence) with less time left than this. */
  minEscalationWindowMs: number;
  /** Value of waiting, in USD-equivalent per second of expected latency. */
  latencyCostUsdPerSecond: number;
  maxLocalAttempts: number;
  maxAttemptsPerPeer: number;
  /** A retry of the same executor after a wrong answer is correlated with it: q' = q·(1-ρ). */
  retryCorrelation: number;
  /** Multiplicative penalty on success probability per unit of reasoningDepth (applied to all executors alike). */
  depthPenalty: number;
  /** Highest dependencyCoupling at which the whole task may go to one black-box peer. */
  couplingMaxForDelegate: number;
  /** Highest dependencyCoupling at which independent parallel solves are worthwhile. */
  couplingMaxForParallel: number;
  parallelMaxWidth: number;
  /** Without a verifier: stop once the best calibrated confidence reaches this. */
  sufficientConfidence: number;
  /** Fraction of task value charged as risk for sending data to a peer of this tier. */
  trustPenalty: Record<TrustTier, number>;
  /** Extra risk fraction while a peer's circuit is half-open. */
  halfOpenPenalty: number;
  /** How much a tier upgrade is expected to help separate conflicting answers (0..1). */
  evidenceInformativeness: number;
  /** Actions must clear this net value (USD-equivalent). */
  minNetValueUsd: number;
  exploration: ExplorationConfig;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: 'dvo-rules/1.0.0',
  minEscalationWindowMs: 5_000,
  latencyCostUsdPerSecond: 0.0005,
  maxLocalAttempts: 2,
  maxAttemptsPerPeer: 2,
  retryCorrelation: 0.5,
  depthPenalty: 0.3,
  couplingMaxForDelegate: 0.75,
  couplingMaxForParallel: 0.45,
  parallelMaxWidth: 3,
  sufficientConfidence: 0.9,
  trustPenalty: { public: 0.04, internal: 0.02, restricted: 0.01 },
  halfOpenPenalty: 0.05,
  evidenceInformativeness: 0.5,
  minNetValueUsd: 0,
  exploration: { enabled: false, epsilon: 0.1, seed: 0 },
};

export function policyConfig(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY_CONFIG,
    ...overrides,
    trustPenalty: { ...DEFAULT_POLICY_CONFIG.trustPenalty, ...overrides.trustPenalty },
    exploration: { ...DEFAULT_POLICY_CONFIG.exploration, ...overrides.exploration },
  };
}
