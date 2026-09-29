import type { CandidateAction, PolicyDecision, PolicyEngine, PolicyInput } from '@dvo/core';

/**
 * Off-policy evaluation for the V2 "delegation marginal value" study (design §7.2).
 * Estimates the value of a target policy from decisions logged under an exploring
 * logging policy. Only meaningful when logged propensities are the true selection
 * probabilities — which is why they are recorded on every decision.
 */
export interface LoggedDecision {
  context: Record<string, number>;
  /** Canonical action key, e.g. `delegate:research-peer-01`. */
  action: string;
  propensity: number;
  reward: number;
}

/** π(a | x) of the policy being evaluated. */
export type TargetProbability = (context: Record<string, number>, action: string) => number;

export interface OpeEstimate {
  estimate: number;
  n: number;
}

export function inverseProbabilityWeighting(logs: readonly LoggedDecision[], target: TargetProbability): OpeEstimate {
  if (logs.length === 0) return { estimate: 0, n: 0 };
  const total = logs.reduce((sum, d) => sum + (target(d.context, d.action) / d.propensity) * d.reward, 0);
  return { estimate: total / logs.length, n: logs.length };
}

export function selfNormalisedIpw(logs: readonly LoggedDecision[], target: TargetProbability): OpeEstimate {
  let weighted = 0;
  let weights = 0;
  for (const d of logs) {
    const w = target(d.context, d.action) / d.propensity;
    weighted += w * d.reward;
    weights += w;
  }
  return { estimate: weights === 0 ? 0 : weighted / weights, n: logs.length };
}

/**
 * Doubly-robust estimator: direct-method prediction corrected by the importance-weighted
 * residual. Unbiased if either the reward model or the propensities are correct.
 */
export function doublyRobust(
  logs: readonly LoggedDecision[],
  target: TargetProbability,
  rewardModel: (context: Record<string, number>, action: string) => number,
  actions: (context: Record<string, number>) => readonly string[],
): OpeEstimate {
  if (logs.length === 0) return { estimate: 0, n: 0 };
  let total = 0;
  for (const d of logs) {
    const direct = actions(d.context).reduce((sum, a) => sum + target(d.context, a) * rewardModel(d.context, a), 0);
    const w = target(d.context, d.action) / d.propensity;
    total += direct + w * (d.reward - rewardModel(d.context, d.action));
  }
  return { estimate: total / logs.length, n: logs.length };
}

export interface CoverageReport {
  n: number;
  effectiveSampleSize: number;
  minPropensity: number;
  maxWeight: number;
  ok: boolean;
  reasons: string[];
}

/** Whether logged data supports evaluating (or deploying) the target policy at all. */
export function coverageReport(
  logs: readonly LoggedDecision[],
  target: TargetProbability,
  thresholds: { minN: number; minEss: number; minPropensity: number; maxWeight: number } = {
    minN: 200,
    minEss: 50,
    minPropensity: 0.01,
    maxWeight: 50,
  },
): CoverageReport {
  const weights = logs.map((d) => target(d.context, d.action) / d.propensity);
  const sum = weights.reduce((a, b) => a + b, 0);
  const sumSq = weights.reduce((a, b) => a + b * b, 0);
  const effectiveSampleSize = sumSq === 0 ? 0 : (sum * sum) / sumSq;
  const minPropensity = logs.length === 0 ? 0 : Math.min(...logs.map((d) => d.propensity));
  const maxWeight = weights.length === 0 ? 0 : Math.max(...weights);
  const reasons: string[] = [];
  if (logs.length < thresholds.minN) reasons.push(`n=${logs.length} < ${thresholds.minN}`);
  if (effectiveSampleSize < thresholds.minEss) reasons.push(`ESS=${effectiveSampleSize.toFixed(1)} < ${thresholds.minEss}`);
  if (minPropensity < thresholds.minPropensity) reasons.push(`min propensity ${minPropensity} < ${thresholds.minPropensity}`);
  if (maxWeight > thresholds.maxWeight) reasons.push(`max importance weight ${maxWeight.toFixed(1)} > ${thresholds.maxWeight}`);
  return { n: logs.length, effectiveSampleSize, minPropensity, maxWeight, ok: reasons.length === 0, reasons };
}

/** Learned action-value model (V2). Returns undefined when it has no opinion. */
export interface ValueModel {
  readonly version: string;
  score(input: PolicyInput, candidate: CandidateAction): number | undefined;
}

/**
 * Uses a learned value model only when a coverage report says the logged data supports it;
 * otherwise — and for every hard-rule decision — it is exactly the fallback rule policy.
 */
export class CoverageGatedPolicy implements PolicyEngine {
  readonly version: string;
  readonly #fallback: PolicyEngine;
  readonly #model: ValueModel | undefined;
  readonly #coverage: CoverageReport;

  constructor(fallback: PolicyEngine, model: ValueModel | undefined, coverage: CoverageReport) {
    this.#fallback = fallback;
    this.#model = model;
    this.#coverage = coverage;
    this.version = model !== undefined && coverage.ok ? `${fallback.version}+${model.version}` : fallback.version;
  }

  decide(input: PolicyInput): PolicyDecision {
    const base = this.#fallback.decide(input);
    if (this.#model === undefined || !this.#coverage.ok) return base;
    if (base.selected.kind === 'verify' || (base.selected.kind === 'stop' && base.selected.reason !== 'sufficient_evidence')) return base;
    const scored = base.candidates
      .filter((c) => c.blockedBy === undefined)
      .map((c) => ({ c, score: this.#model!.score(input, c) }))
      .filter((x): x is { c: CandidateAction; score: number } => x.score !== undefined)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best === undefined) return base;
    return {
      ...base,
      selected: best.c.action,
      reason: `learned value ${best.score.toFixed(4)} (${this.#model.version})`,
      propensity: 1,
      explored: false,
    };
  }
}

/** Canonical action key used in logged decisions. */
export function actionKey(action: PolicyDecision['selected']): string {
  switch (action.kind) {
    case 'delegate':
      return `delegate:${action.peerId}`;
    case 'parallel':
      return `parallel:${[...action.peerIds].sort().join('+')}`;
    case 'stop':
      return `stop:${action.reason}`;
    default:
      return action.kind;
  }
}
