import {
  affordability,
  type AttemptId,
  type BlockReason,
  type CandidateAction,
  describeAction,
  type EvidenceTier,
  exhaustedDimension,
  addSpend,
  mulberry32,
  type OrchestrationAction,
  type PeerId,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInput,
  type PolicyPeerView,
  seedFrom,
  type StopReason,
  tierClears,
} from '@dvo/core';
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from './config.ts';
import { adjustForDepth, candidateProbabilities, effectiveVerifiability, primaryConflict, successProbability } from './value.ts';

interface Estimate {
  gain: number;
  lcb: number;
  costUsd: number;
  latencyMs: number;
  risk: number;
  remoteCalls: number;
  width: number;
}

/**
 * MVP Delegation Value Orchestrator policy (design §7.1, appendix C).
 *
 * Order of precedence — each step can only *restrict* what later steps may do:
 *  1. hard limits: deadline, budget, safety → stop;
 *  2. a verified answer exists → stop(sufficient_evidence);
 *  3. unverified answers and a deterministic verifier is available → verify;
 *  4. value gating: an escalation (delegate / parallel / request_evidence) is taken only if
 *     its gain computed from *lower confidence bounds* exceeds its cost, latency cost and
 *     risk penalty; otherwise continue locally if nothing has been produced yet;
 *  5. otherwise stop with the best available answer.
 * Every candidate is recorded with its estimate and the reasons it was blocked.
 */
export class DvoRulePolicy implements PolicyEngine {
  readonly version: string;
  readonly #config: PolicyConfig;

  constructor(config: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.#config = config;
    this.version = config.version;
  }

  decide(input: PolicyInput): PolicyDecision {
    const features = extractFeatures(input);
    const committedPlusReserved = addSpend(input.spent, input.reserved);

    // 1. Hard limits.
    if (input.remainingMs <= 0) return this.#stop('deadline', 'deadline reached', features);
    if (exhaustedDimension(input.budget, committedPlusReserved) !== undefined) {
      return this.#stop('budget', `budget exhausted (${exhaustedDimension(input.budget, committedPlusReserved)})`, features);
    }

    const results = input.results;
    const verifiability = effectiveVerifiability(input);
    const qs = candidateProbabilities(results);
    const pNow = successProbability(qs, verifiability);

    // 2. Verified answer → done.
    if (results.some((r) => r.verification === 'verified' && r.terminalStatus === 'completed')) {
      return this.#stop('sufficient_evidence', 'a result has been verified by a local verifier', features);
    }

    const candidates: CandidateAction[] = [];
    candidates.push(this.#verifyCandidate(input));
    candidates.push(this.#localCandidate(input, qs, verifiability, pNow));
    const delegates = input.peers.map((peer) => this.#delegateCandidate(input, peer, qs, verifiability, pNow));
    candidates.push(...delegates);
    candidates.push(this.#parallelCandidate(input, qs, verifiability, pNow));
    candidates.push(this.#requestEvidenceCandidate(input, qs, pNow));

    // 3. Verify before trusting anything.
    const verify = candidates[0]!;
    if (verify.blockedBy === undefined) {
      return this.#decision(verify.action, candidates, 'unverified result(s) and a deterministic verifier is available', features);
    }

    // 4. Value gating.
    const hasAnswer = qs.length > 0;
    const eligible = candidates.filter((c) => {
      if (c.blockedBy !== undefined) return false;
      switch (c.action.kind) {
        case 'delegate':
        case 'parallel':
        case 'request_evidence':
          return c.netValue > this.#config.minNetValueUsd && c.lowerConfidenceBound > c.estimatedCostUsd + c.riskPenalty;
        case 'continue_local':
          return !hasAnswer || c.netValue > this.#config.minNetValueUsd;
        case 'verify':
        case 'stop':
          return false;
      }
    });
    for (const c of candidates) {
      if (c.blockedBy === undefined && !eligible.includes(c) && c.action.kind !== 'verify') c.blockedBy = ['not_worth_cost'];
    }

    const sufficient = hasAnswer && verifiability === 0 && Math.max(...qs) >= this.#config.sufficientConfidence;
    if (sufficient) {
      return this.#decision(
        { kind: 'stop', reason: 'sufficient_evidence' },
        candidates,
        `best calibrated confidence ${Math.max(...qs).toFixed(2)} ≥ ${this.#config.sufficientConfidence}`,
        features,
      );
    }

    if (eligible.length > 0) {
      const greedy = [...eligible].sort(byNetValue)[0]!;
      // Exploration may pick any *permitted* action — including ones the value gate rejected —
      // but never one blocked by a hard constraint (budget, safety, deadline, availability).
      const permitted = candidates.filter(
        (c) =>
          c.action.kind !== 'verify' &&
          c.action.kind !== 'stop' &&
          (c.blockedBy === undefined || c.blockedBy.every((b) => b === 'not_worth_cost')),
      );
      const explored = this.#maybeExplore(input, permitted, greedy);
      const chosen = explored?.choice ?? greedy;
      return this.#decision(
        chosen.action,
        candidates,
        explain(chosen, candidates, pNow),
        features,
        explored?.propensity ?? 1,
        explored !== undefined && explored.choice !== greedy,
      );
    }

    // 5. Nothing worth doing.
    if (hasAnswer) {
      return this.#decision(
        { kind: 'stop', reason: 'sufficient_evidence' },
        candidates,
        `no action improves on the current answer (P=${pNow.toFixed(2)}); ${whyNotDelegate(delegates)}`,
        features,
      );
    }
    const reason = stopReasonFromBlocks(candidates);
    return this.#decision({ kind: 'stop', reason }, candidates, `no eligible action and no answer; ${whyNotDelegate(delegates)}`, features);
  }

  // ─── candidates ───────────────────────────────────────────────────────────────

  #verifyCandidate(input: PolicyInput): CandidateAction {
    const targets = input.results
      .filter((r) => r.terminalStatus === 'completed' && r.verification === 'unverified')
      .map((r) => r.attemptId);
    const verifierId = input.verifierId ?? 'none';
    const action: OrchestrationAction = { kind: 'verify', verifierId, targetAttemptIds: targets };
    const blocked: BlockReason[] = [];
    const verifier = input.verifiers.find((v) => v.id === input.verifierId);
    if (input.verifierId === undefined || targets.length === 0) blocked.push('nothing_to_verify');
    else if (verifier === undefined || !verifier.available || !verifier.deterministic) blocked.push('verifier_unavailable');
    else if ((verifier.active ?? 0) > 0) blocked.push('executor_busy');
    const qs = input.results.filter((r) => targets.includes(r.attemptId)).map((r) => r.calibratedConfidence);
    const gain = input.successValueUsd * (successProbability(qs, 1) - successProbability(qs, 0));
    return candidate(action, { gain, lcb: gain, costUsd: 0, latencyMs: 1_000, risk: 0, remoteCalls: 0, width: 0 }, blocked, this.#config);
  }

  #localCandidate(input: PolicyInput, qs: number[], v: number, pNow: number): CandidateAction {
    const action: OrchestrationAction = { kind: 'continue_local' };
    const local = input.local;
    const blocked: BlockReason[] = [];
    if (local === undefined || !local.available) {
      blocked.push('local_unavailable');
      return candidate(action, ZERO_ESTIMATE, blocked, this.#config);
    }
    if (local.active > 0) blocked.push('executor_busy');
    if (local.attemptsSoFar >= this.#config.maxLocalAttempts) blocked.push('local_attempts_exhausted');
    if (local.estLatencyMs > input.remainingMs) blocked.push('latency_exceeds_deadline');
    // Retries after a completed-but-wrong local answer are correlated with it.
    const completedLocal = local.attemptsSoFar - local.failedAttempts;
    const correlation = (1 - this.#config.retryCorrelation) ** Math.max(0, completedLocal);
    const qMean = adjustForDepth(local.reliability.mean, input.hardness.reasoningDepth, this.#config.depthPenalty) * correlation;
    const qLcb = adjustForDepth(local.reliability.lcb, input.hardness.reasoningDepth, this.#config.depthPenalty) * correlation;
    const est: Estimate = {
      gain: input.successValueUsd * (successProbability([...qs, qMean], v) - pNow),
      lcb: input.successValueUsd * (successProbability([...qs, qLcb], v) - pNow),
      costUsd: local.estCostUsd,
      latencyMs: local.estLatencyMs,
      risk: 0,
      remoteCalls: 0,
      width: 1,
    };
    this.#budgetBlocks(input, est, blocked);
    return candidate(action, est, blocked, this.#config);
  }

  #peerBlocks(input: PolicyInput, peer: PolicyPeerView): BlockReason[] {
    const blocked: BlockReason[] = [];
    if (!input.allowRemote) blocked.push('remote_disallowed');
    if (input.classification === 'secret') blocked.push('classification');
    else if (input.classification === 'restricted') {
      if (!peer.allowRestricted || peer.trustTier !== 'restricted') blocked.push('classification');
      else if (!input.restrictedDelegationApproved) blocked.push('approval_required');
    } else if (!tierClears(peer.trustTier, input.classification)) blocked.push('classification');
    if (peer.circuit === 'open') blocked.push('circuit_open');
    if (!peer.available) blocked.push('peer_unavailable');
    if (input.requiredSkills.length > 0 && !input.requiredSkills.every((s) => peer.skills.includes(s))) blocked.push('skill_mismatch');
    if (peer.active > 0) blocked.push('executor_busy');
    if (peer.attemptsSoFar >= this.#config.maxAttemptsPerPeer) blocked.push('peer_attempts_exhausted');
    if (peer.estLatencyMs > input.remainingMs) blocked.push('latency_exceeds_deadline');
    if (input.remainingMs < this.#config.minEscalationWindowMs) blocked.push('deadline_window');
    return blocked;
  }

  #peerProbabilities(input: PolicyInput, peer: PolicyPeerView): { mean: number; lcb: number } {
    // Asking the same peer again after it already answered is correlated with that answer.
    const answered = input.results.filter((r) => r.peerId === peer.peerId && r.terminalStatus === 'completed').length;
    const correlation = (1 - this.#config.retryCorrelation) ** answered;
    return {
      mean: adjustForDepth(peer.reliability.mean, input.hardness.reasoningDepth, this.#config.depthPenalty) * correlation,
      lcb: adjustForDepth(peer.reliability.lcb, input.hardness.reasoningDepth, this.#config.depthPenalty) * correlation,
    };
  }

  #peerRisk(input: PolicyInput, peer: PolicyPeerView): number {
    const fraction = this.#config.trustPenalty[peer.trustTier] + (peer.circuit === 'half_open' ? this.#config.halfOpenPenalty : 0);
    return input.successValueUsd * fraction;
  }

  #delegateCandidate(input: PolicyInput, peer: PolicyPeerView, qs: number[], v: number, pNow: number): CandidateAction {
    const tier = evidenceTierFor(input, peer);
    const action: OrchestrationAction = { kind: 'delegate', peerId: peer.peerId, evidenceTier: tier };
    const blocked = this.#peerBlocks(input, peer);
    if (input.hardness.dependencyCoupling > this.#config.couplingMaxForDelegate) blocked.push('not_decomposable');
    const p = this.#peerProbabilities(input, peer);
    const est: Estimate = {
      gain: input.successValueUsd * (successProbability([...qs, p.mean], v) - pNow),
      lcb: input.successValueUsd * (successProbability([...qs, p.lcb], v) - pNow),
      costUsd: peer.estCostUsd,
      latencyMs: peer.estLatencyMs,
      risk: this.#peerRisk(input, peer),
      remoteCalls: 1,
      width: 1,
    };
    this.#budgetBlocks(input, est, blocked);
    return candidate(action, est, blocked, this.#config);
  }

  #parallelCandidate(input: PolicyInput, qs: number[], v: number, pNow: number): CandidateAction {
    const blocked: BlockReason[] = [];
    if (input.hardness.dependencyCoupling > this.#config.couplingMaxForParallel) blocked.push('not_decomposable');
    const usable = input.peers
      .filter((peer) => this.#peerBlocks(input, peer).length === 0)
      .sort((a, b) => b.reliability.lcb - a.reliability.lcb || a.estCostUsd - b.estCostUsd || cmp(a.peerId, b.peerId));
    const width = Math.min(
      this.#config.parallelMaxWidth,
      usable.length,
      input.budget.maxParallelAttempts - input.activeAttempts,
      input.budget.maxRemoteCalls - input.spent.remoteCalls - input.reserved.remoteCalls,
    );
    const chosen = usable.slice(0, Math.max(0, width));
    const tier = chosen.length === 0 ? 0 : (Math.min(...chosen.map((p) => evidenceTierFor(input, p))) as EvidenceTier);
    const action: OrchestrationAction = { kind: 'parallel', peerIds: chosen.map((p) => p.peerId), evidenceTier: tier };
    if (chosen.length < 2) {
      blocked.push(input.budget.maxParallelAttempts - input.activeAttempts < 2 ? 'max_parallel' : 'insufficient_peers');
      return candidate(action, ZERO_ESTIMATE, blocked, this.#config);
    }
    const probs = chosen.map((peer) => this.#peerProbabilities(input, peer));
    const est: Estimate = {
      gain: input.successValueUsd * (successProbability([...qs, ...probs.map((p) => p.mean)], v) - pNow),
      lcb: input.successValueUsd * (successProbability([...qs, ...probs.map((p) => p.lcb)], v) - pNow),
      costUsd: chosen.reduce((sum, p) => sum + p.estCostUsd, 0),
      latencyMs: Math.max(...chosen.map((p) => p.estLatencyMs)),
      risk: chosen.reduce((sum, p) => sum + this.#peerRisk(input, p), 0),
      remoteCalls: chosen.length,
      width: chosen.length,
    };
    this.#budgetBlocks(input, est, blocked);
    return candidate(action, est, blocked, this.#config);
  }

  #requestEvidenceCandidate(input: PolicyInput, qs: number[], pNow: number): CandidateAction {
    const conflict = primaryConflict(input.results);
    const blocked: BlockReason[] = [];
    const remote = input.results
      .filter((r) => conflict?.attemptIds.includes(r.attemptId) === true && r.peerId !== undefined)
      .map((r) => ({ result: r, peer: input.peers.find((p) => p.peerId === r.peerId) }))
      .filter((x): x is { result: (typeof input.results)[number]; peer: PolicyPeerView } => x.peer !== undefined)
      .filter((x) => x.result.tier < x.peer.maxEvidenceTier)
      .sort((a, b) => b.result.calibratedConfidence - a.result.calibratedConfidence || cmp(a.result.attemptId, b.result.attemptId));
    const target = remote[0];
    const action: OrchestrationAction = {
      kind: 'request_evidence',
      attemptId: target?.result.attemptId ?? ('none' as AttemptId),
      nextTier: target === undefined ? 1 : (Math.min(2, target.result.tier + 1) as 1 | 2),
    };
    if (conflict === undefined) blocked.push('no_conflict');
    if (target === undefined) {
      if (conflict !== undefined) blocked.push('tier_unsupported');
      return candidate(action, ZERO_ESTIMATE, blocked, this.#config);
    }
    blocked.push(...this.#peerBlocks(input, target.peer).filter((b) => b !== 'peer_attempts_exhausted' && b !== 'not_decomposable'));
    const separable = successProbability(qs, 1);
    const gain = input.successValueUsd * this.#config.evidenceInformativeness * Math.max(0, separable - pNow);
    const est: Estimate = {
      gain,
      lcb: (gain * target.peer.reliability.lcb) / Math.max(1e-6, target.peer.reliability.mean),
      costUsd: target.peer.estCostUsd,
      latencyMs: target.peer.estLatencyMs,
      risk: this.#peerRisk(input, target.peer),
      remoteCalls: 1,
      width: 1,
    };
    this.#budgetBlocks(input, est, blocked);
    return candidate(action, est, blocked, this.#config);
  }

  #budgetBlocks(input: PolicyInput, est: Estimate, blocked: BlockReason[]): void {
    const check = affordability(input.budget, input.spent, input.reserved, { costUsd: est.costUsd, remoteCalls: est.remoteCalls });
    if (!check.ok) {
      blocked.push(
        check.dimension === 'cost' ? 'budget_cost' : check.dimension === 'remote_calls' ? 'budget_remote_calls' : 'budget_tokens',
      );
    }
    if (est.width > 0 && input.activeAttempts + est.width > input.budget.maxParallelAttempts) blocked.push('max_parallel');
  }

  // ─── selection helpers ────────────────────────────────────────────────────────

  #maybeExplore(
    input: PolicyInput,
    eligible: CandidateAction[],
    greedy: CandidateAction,
  ): { choice: CandidateAction; propensity: number } | undefined {
    const { exploration } = this.#config;
    const safe = input.safeForExploration && input.classification === 'public' && input.verifierId !== undefined;
    if (!exploration.enabled || !safe || eligible.length < 2) return undefined;
    const random = mulberry32(seedFrom(`${exploration.seed}:${input.taskId}:${input.decisionIndex}`));
    const explore = random() < exploration.epsilon;
    const uniform = exploration.epsilon / eligible.length;
    if (!explore) return { choice: greedy, propensity: 1 - exploration.epsilon + uniform };
    const choice = eligible[Math.floor(random() * eligible.length)]!;
    return { choice, propensity: choice === greedy ? 1 - exploration.epsilon + uniform : uniform };
  }

  #stop(reason: StopReason, why: string, features: Record<string, number>): PolicyDecision {
    return this.#decision({ kind: 'stop', reason }, [], why, features);
  }

  #decision(
    selected: OrchestrationAction,
    candidates: CandidateAction[],
    reason: string,
    features: Record<string, number>,
    propensity = 1,
    explored = false,
  ): PolicyDecision {
    return { selected, candidates, reason, propensity, explored, features };
  }
}

const ZERO_ESTIMATE: Estimate = { gain: 0, lcb: 0, costUsd: 0, latencyMs: 0, risk: 0, remoteCalls: 0, width: 0 };

function candidate(action: OrchestrationAction, est: Estimate, blocked: BlockReason[], config: PolicyConfig): CandidateAction {
  const latencyCost = (config.latencyCostUsdPerSecond * est.latencyMs) / 1000;
  const unique = [...new Set(blocked)];
  return {
    action,
    estimatedGain: round(est.gain),
    lowerConfidenceBound: round(est.lcb),
    estimatedCostUsd: round(est.costUsd),
    estimatedLatencyMs: Math.round(est.latencyMs),
    riskPenalty: round(est.risk),
    netValue: round(est.lcb - est.costUsd - latencyCost - est.risk),
    ...(unique.length === 0 ? {} : { blockedBy: unique }),
  };
}

/** Tier-1 evidence by default; tier 2 only when the task is verifiable and the peer carries it. */
function evidenceTierFor(input: PolicyInput, peer: PolicyPeerView): EvidenceTier {
  const verifiable = effectiveVerifiability(input) === 1 || input.hardness.verifiability >= 0.5;
  const wanted: EvidenceTier = verifiable ? 2 : 1;
  return Math.min(wanted, peer.maxEvidenceTier) as EvidenceTier;
}

function byNetValue(a: CandidateAction, b: CandidateAction): number {
  return b.netValue - a.netValue || kindRank(a) - kindRank(b) || cmp(describeAction(a.action), describeAction(b.action));
}

/** Ties go to the cheaper, less exposed action. */
function kindRank(c: CandidateAction): number {
  return ['continue_local', 'verify', 'request_evidence', 'delegate', 'parallel', 'stop'].indexOf(c.action.kind);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stopReasonFromBlocks(candidates: CandidateAction[]): StopReason {
  const reasons = new Set(candidates.flatMap((c) => c.blockedBy ?? []));
  if (reasons.has('deadline_window') || reasons.has('latency_exceeds_deadline')) return 'deadline';
  if (reasons.has('budget_cost') || reasons.has('budget_remote_calls') || reasons.has('budget_tokens')) return 'budget';
  if (
    reasons.has('classification') ||
    reasons.has('approval_required') ||
    reasons.has('remote_disallowed') ||
    reasons.has('local_unavailable')
  ) {
    return 'unsafe';
  }
  return 'budget';
}

function explain(chosen: CandidateAction, candidates: CandidateAction[], pNow: number): string {
  const head = `${describeAction(chosen.action)}: LCB gain ${chosen.lowerConfidenceBound.toFixed(4)} vs cost ${chosen.estimatedCostUsd.toFixed(4)} + risk ${chosen.riskPenalty.toFixed(4)} (net ${chosen.netValue.toFixed(4)}, P now ${pNow.toFixed(2)})`;
  const runnerUp = candidates.filter((c) => c !== chosen && c.blockedBy === undefined).sort(byNetValue)[0];
  return runnerUp === undefined ? head : `${head}; runner-up ${describeAction(runnerUp.action)} net ${runnerUp.netValue.toFixed(4)}`;
}

/** Answers "why was nothing delegated?" from the delegate candidates' block reasons. */
export function whyNotDelegate(delegates: CandidateAction[]): string {
  if (delegates.length === 0) return 'no peers configured';
  const reasons = new Map<string, PeerId[]>();
  for (const c of delegates) {
    if (c.action.kind !== 'delegate') continue;
    for (const reason of c.blockedBy ?? ['eligible']) reasons.set(reason, [...(reasons.get(reason) ?? []), c.action.peerId]);
  }
  return `delegation not taken: ${[...reasons.entries()].map(([r, peers]) => `${r} (${peers.join(', ')})`).join('; ')}`;
}

export function extractFeatures(input: PolicyInput): Record<string, number> {
  const qs = candidateProbabilities(input.results);
  return {
    remainingMs: Math.max(0, input.remainingMs),
    costFraction: round((input.spent.costUsd + input.reserved.costUsd) / Math.max(1e-9, input.budget.maxCostUsd)),
    remoteCallsLeft: input.budget.maxRemoteCalls - input.spent.remoteCalls - input.reserved.remoteCalls,
    reasoningDepth: input.hardness.reasoningDepth,
    skillBreadth: input.hardness.skillBreadth,
    dependencyCoupling: input.hardness.dependencyCoupling,
    informationFragmentation: input.hardness.informationFragmentation,
    ambiguity: input.hardness.ambiguity,
    verifiability: input.hardness.verifiability,
    currentFailureRisk: input.hardness.currentFailureRisk,
    results: input.results.length,
    bestConfidence: qs.length === 0 ? 0 : round(Math.max(...qs)),
    conflict: primaryConflict(input.results) === undefined ? 0 : 1,
    peersAvailable: input.peers.filter((p) => p.available && p.circuit !== 'open').length,
    verifierAvailable: effectiveVerifiability(input),
    decisionIndex: input.decisionIndex,
  };
}
