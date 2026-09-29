import {
  AttemptId,
  NEUTRAL_HARDNESS,
  PeerId,
  type PolicyInput,
  type PolicyPeerView,
  type PolicyResultView,
  TaskId,
  ZERO_SPEND,
} from '@dvo/core';

export function peer(id: string, overrides: Partial<PolicyPeerView> = {}): PolicyPeerView {
  return {
    peerId: PeerId(id),
    skills: ['general'],
    trustTier: 'internal',
    circuit: 'closed',
    available: true,
    reliability: { mean: 0.85, lcb: 0.75, n: 40 },
    estCostUsd: 0.01,
    estLatencyMs: 2000,
    maxEvidenceTier: 2,
    attemptsSoFar: 0,
    active: 0,
    allowRestricted: false,
    ...overrides,
  };
}

export function result(id: string, overrides: Partial<PolicyResultView> = {}): PolicyResultView {
  return {
    attemptId: AttemptId(id),
    executorId: 'dsh-local',
    executorKind: 'dsh-local',
    terminalStatus: 'completed',
    calibratedConfidence: 0.5,
    verification: 'unverified',
    quarantined: false,
    injectionRisk: 'low',
    tier: 1,
    claimDigests: { answer: 'digest-a' },
    ...overrides,
  };
}

export function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    schemaVersion: 1,
    taskId: TaskId('tsk_policy'),
    decisionIndex: 0,
    nowMs: 0,
    deadlineMs: 300_000,
    remainingMs: 300_000,
    classification: 'internal',
    allowRemote: true,
    restrictedDelegationApproved: false,
    requiredSkills: [],
    successValueUsd: 1,
    safeForExploration: false,
    hardness: { ...NEUTRAL_HARDNESS, dependencyCoupling: 0.3 },
    budget: {
      maxCostUsd: 1,
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxRemoteCalls: 4,
      maxParallelAttempts: 3,
      deadlineAt: '2026-01-01T00:05:00.000Z',
    },
    spent: { ...ZERO_SPEND },
    reserved: { ...ZERO_SPEND },
    activeAttempts: 0,
    results: [],
    local: {
      executorId: 'dsh-local',
      available: true,
      reliability: { mean: 0.6, lcb: 0.45, n: 30 },
      estCostUsd: 0.005,
      estLatencyMs: 5000,
      attemptsSoFar: 0,
      failedAttempts: 0,
      active: 0,
    },
    peers: [],
    verifiers: [],
    ...overrides,
  };
}
