import {
  type AttemptState,
  attemptsOf,
  fromIso,
  isTerminalAttemptStatus,
  type PolicyInput,
  type PolicyPeerView,
  type PolicyResultView,
  type TaskState,
} from '@dvo/core';
import { claimDigests } from '@dvo/evidence';
import { updateFailureRisk } from '@dvo/policy';
import type { CircuitRegistry } from '@dvo/scheduler';
import { type CapabilityCache, type ExecutorCatalog } from './catalog.ts';
import type { ReliabilityTracker } from './reliability.ts';

export interface SnapshotDeps {
  catalog: ExecutorCatalog;
  capabilities: CapabilityCache;
  circuits: CircuitRegistry;
  reliability: ReliabilityTracker;
  defaultSkill: string;
  /** Fallback latency estimate when an executor has no history (fraction of its timeout). */
  latencyPriorFraction: number;
}

export function skillOf(state: TaskState, fallback: string): string {
  return state.requiredSkills[0] ?? fallback;
}

/**
 * Builds the policy's entire view of the world. Only non-sensitive metadata goes in —
 * answers appear as digests — because the input is persisted with every decision.
 */
export async function buildPolicyInput(state: TaskState, nowMs: number, deps: SnapshotDeps): Promise<PolicyInput> {
  const attempts = attemptsOf(state);
  const skill = skillOf(state, deps.defaultSkill);
  const active = (predicate: (a: AttemptState) => boolean): number =>
    attempts.filter((a) => !isTerminalAttemptStatus(a.status) && predicate(a)).length;

  const results: PolicyResultView[] = attempts
    .filter((a) => a.executorKind !== 'verifier' && a.result !== undefined)
    .map((a) => ({
      attemptId: a.attemptId,
      executorId: a.executorId,
      executorKind: a.executorKind,
      ...(a.peerId === undefined ? {} : { peerId: a.peerId }),
      terminalStatus: a.result!.terminalStatus,
      calibratedConfidence: a.result!.calibratedConfidence,
      verification: a.verification,
      quarantined: a.result!.quarantined,
      injectionRisk: a.result!.injectionRisk,
      tier: a.result!.output?.tier ?? 0,
      claimDigests: claimDigests(a.result!.output),
    }));

  let local: PolicyInput['local'];
  if (deps.catalog.local !== undefined) {
    const d = deps.catalog.local;
    const caps = await deps.capabilities.get(d.executor);
    const mine = attempts.filter((a) => a.executorId === d.executor.id);
    local = {
      executorId: d.executor.id,
      available: caps.available,
      reliability: deps.reliability.estimate(d.executor.id, skill, 'dsh-local'),
      estCostUsd: deps.reliability.meanCost(d.executor.id) ?? d.costEstimateUsd,
      estLatencyMs: deps.reliability.latencyP95(d.executor.id) ?? d.timeoutMs * deps.latencyPriorFraction,
      attemptsSoFar: mine.length,
      failedAttempts: mine.filter((a) => isTerminalAttemptStatus(a.status) && a.result?.terminalStatus !== 'completed').length,
      active: active((a) => a.executorId === d.executor.id),
    };
  }

  const peers: PolicyPeerView[] = [];
  for (const d of deps.catalog.peers) {
    const caps = await deps.capabilities.get(d.executor);
    peers.push({
      peerId: d.peerId,
      skills: caps.skills,
      trustTier: d.trustTier,
      circuit: deps.circuits.get(d.executor.id).state,
      available: caps.available,
      reliability: deps.reliability.estimate(d.executor.id, skill, 'a2a-peer'),
      estCostUsd: deps.reliability.meanCost(d.executor.id) ?? d.costPerCallUsd,
      estLatencyMs: deps.reliability.latencyP95(d.executor.id) ?? d.timeoutMs * deps.latencyPriorFraction,
      maxEvidenceTier: caps.maxEvidenceTier,
      attemptsSoFar: attempts.filter((a) => a.peerId === d.peerId).length,
      active: active((a) => a.peerId === d.peerId),
      allowRestricted: d.allowRestricted,
    });
  }

  const verifiers = (await deps.catalog.verifiers.views()).map((v) => ({
    ...v,
    active: active((a) => a.executorId === `verifier:${v.id}`),
  }));

  const trajectory = {
    failed: attempts.filter((a) => a.executorKind !== 'verifier' && a.status === 'failed').length,
    refuted: attempts.filter((a) => a.verification === 'refuted').length,
    completed: results.filter((r) => r.terminalStatus === 'completed').length,
  };
  const deadlineMs = fromIso(state.budget.deadlineAt);
  return {
    schemaVersion: 1,
    taskId: state.taskId,
    decisionIndex: state.decisionCount,
    nowMs,
    deadlineMs,
    remainingMs: deadlineMs - nowMs,
    classification: state.classification,
    allowRemote: state.allowRemote,
    restrictedDelegationApproved: state.approvals.restrictedDelegation,
    requiredSkills: state.requiredSkills,
    successValueUsd: state.successValueUsd,
    safeForExploration: state.safeForExploration,
    hardness: updateFailureRisk(state.hardnessProfile, trajectory),
    budget: state.budget,
    spent: state.spent,
    reserved: state.reserved,
    activeAttempts: state.activeAttempts.length,
    ...(state.verification === undefined ? {} : { verifierId: state.verification.verifierId }),
    results,
    ...(local === undefined ? {} : { local }),
    peers,
    verifiers,
  };
}
