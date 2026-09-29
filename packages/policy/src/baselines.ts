import { type CandidateAction, type OrchestrationAction, type PolicyDecision, type PolicyEngine, type PolicyInput } from '@dvo/core';
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from './config.ts';
import { DvoRulePolicy } from './rule-policy.ts';
import { candidateProbabilities } from './value.ts';

/**
 * Comparison policies for compute-matched evaluation (design §16.2). Each one reuses the
 * DVO candidate generator, so every baseline obeys exactly the same hard limits, safety
 * gates and budgets; only the *choice* among permitted actions differs.
 */
abstract class BaselinePolicy implements PolicyEngine {
  abstract readonly version: string;
  protected readonly base: DvoRulePolicy;

  constructor(config: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    // Baselines gate on permission only, never on value, so value gating is neutralised.
    this.base = new DvoRulePolicy({
      ...config,
      minNetValueUsd: Number.NEGATIVE_INFINITY,
      exploration: { ...config.exploration, enabled: false },
    });
  }

  decide(input: PolicyInput): PolicyDecision {
    const reference = this.base.decide(input);
    // Hard stops and verification are shared behaviour.
    if (reference.candidates.length === 0 || reference.selected.kind === 'verify')
      return { ...reference, reason: `[${this.version}] ${reference.reason}` };
    const permitted = reference.candidates.filter((c) => c.blockedBy === undefined || c.blockedBy.every((b) => b === 'not_worth_cost'));
    const choice = this.choose(input, permitted);
    return {
      ...reference,
      selected: choice.action,
      reason: `[${this.version}] ${choice.reason}`,
      propensity: 1,
      explored: false,
    };
  }

  protected abstract choose(input: PolicyInput, permitted: CandidateAction[]): { action: OrchestrationAction; reason: string };

  protected find(permitted: CandidateAction[], kind: OrchestrationAction['kind']): CandidateAction | undefined {
    return permitted.find((c) => c.action.kind === kind);
  }
}

/** Single agent: only ever runs locally. */
export class LocalOnlyPolicy extends BaselinePolicy {
  readonly version = 'baseline-local-only/1';

  protected choose(input: PolicyInput, permitted: CandidateAction[]) {
    const hasAnswer = candidateProbabilities(input.results).length > 0;
    const local = this.find(permitted, 'continue_local');
    if (!hasAnswer && local !== undefined) return { action: local.action, reason: 'single agent: run locally' };
    return { action: { kind: 'stop', reason: hasAnswer ? 'sufficient_evidence' : 'budget' } as const, reason: 'single agent: done' };
  }
}

/** Fixed topology: fan out to every permitted peer once, then fall back to local. */
export class FixedTopologyPolicy extends BaselinePolicy {
  readonly version = 'baseline-fixed-topology/1';

  protected choose(input: PolicyInput, permitted: CandidateAction[]) {
    const hasAnswer = candidateProbabilities(input.results).length > 0;
    const fanned = input.results.some((r) => r.executorKind === 'a2a-peer') || input.peers.some((p) => p.attemptsSoFar > 0);
    if (!fanned) {
      const parallel = this.find(permitted, 'parallel');
      if (parallel !== undefined) return { action: parallel.action, reason: 'fixed topology: fan out to all peers' };
      const delegate = permitted.find((c) => c.action.kind === 'delegate');
      if (delegate !== undefined) return { action: delegate.action, reason: 'fixed topology: single peer' };
    }
    const local = this.find(permitted, 'continue_local');
    if (!hasAnswer && local !== undefined) return { action: local.action, reason: 'fixed topology: local fallback' };
    return { action: { kind: 'stop', reason: hasAnswer ? 'sufficient_evidence' : 'budget' } as const, reason: 'fixed topology: done' };
  }
}

/** Confidence gating: run locally, delegate to the best-looking peer if self-reported confidence is low. */
export class ConfidenceGatedPolicy extends BaselinePolicy {
  readonly version: string;
  readonly #threshold: number;

  constructor(threshold = 0.7, config: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    super(config);
    this.#threshold = threshold;
    this.version = `baseline-confidence-gated/${threshold}`;
  }

  protected choose(input: PolicyInput, permitted: CandidateAction[]) {
    const answers = candidateProbabilities(input.results);
    const local = this.find(permitted, 'continue_local');
    if (answers.length === 0 && input.results.length === 0 && local !== undefined) {
      return { action: local.action, reason: 'confidence gate: local first' };
    }
    const best = answers.length === 0 ? 0 : Math.max(...answers);
    if (best < this.#threshold) {
      const delegate = permitted.filter((c) => c.action.kind === 'delegate').sort((a, b) => b.estimatedGain - a.estimatedGain)[0];
      if (delegate !== undefined)
        return { action: delegate.action, reason: `confidence ${best.toFixed(2)} < ${this.#threshold}: delegate` };
      if (local !== undefined && answers.length === 0) return { action: local.action, reason: 'confidence gate: retry local' };
    }
    return {
      action: { kind: 'stop', reason: answers.length > 0 ? 'sufficient_evidence' : 'budget' } as const,
      reason: 'confidence gate: done',
    };
  }
}
