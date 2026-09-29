import {
  type BetaPrior,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorStats,
  histogramPercentile,
  type ReliabilityEstimate,
  reliabilityEstimate,
  type ReliabilityRepository,
} from '@dvo/core';
import { type Calibrator, ShrinkageCalibrator } from '@dvo/policy';

export interface ReliabilityPriors {
  local: BetaPrior;
  peer: BetaPrior;
}

export const DEFAULT_PRIORS: ReliabilityPriors = {
  local: { alpha: 3, beta: 2 },
  peer: { alpha: 1, beta: 1 },
};

/**
 * Observed reliability per executor and skill (design §9.1 "update peer reliability
 * statistics", invariant 4). Agent Card claims never enter here; only settled outcomes do.
 * Skill-specific statistics are used once they have enough support, otherwise the
 * executor-wide aggregate.
 */
export class ReliabilityTracker {
  readonly #repo: ReliabilityRepository;
  readonly #priors: ReliabilityPriors;
  readonly #calibrator: Calibrator;
  readonly #minSkillSupport: number;
  readonly #stats = new Map<string, ExecutorStats>();

  constructor(
    repo: ReliabilityRepository,
    options: { priors?: ReliabilityPriors; calibrator?: Calibrator; minSkillSupport?: number } = {},
  ) {
    this.#repo = repo;
    this.#priors = options.priors ?? DEFAULT_PRIORS;
    this.#calibrator = options.calibrator ?? new ShrinkageCalibrator();
    this.#minSkillSupport = options.minSkillSupport ?? 3;
  }

  get calibrator(): Calibrator {
    return this.#calibrator;
  }

  async refresh(): Promise<void> {
    this.#stats.clear();
    for (const s of await this.#repo.executorStats()) this.#stats.set(key(s.executorId, s.skill), s);
  }

  #aggregate(executorId: string): { successes: number; failures: number; stats: ExecutorStats[] } {
    const stats = [...this.#stats.values()].filter((s) => s.executorId === executorId);
    return {
      successes: stats.reduce((n, s) => n + s.successCount, 0),
      failures: stats.reduce((n, s) => n + s.failureCount, 0),
      stats,
    };
  }

  estimate(executorId: string, skill: string, kind: ExecutorKind): ReliabilityEstimate {
    const prior = kind === 'a2a-peer' ? this.#priors.peer : this.#priors.local;
    const specific = this.#stats.get(key(executorId, skill));
    if (specific !== undefined && specific.successCount + specific.failureCount >= this.#minSkillSupport) {
      return reliabilityEstimate(specific.successCount, specific.failureCount, prior);
    }
    const all = this.#aggregate(executorId);
    return reliabilityEstimate(all.successes, all.failures, prior);
  }

  /** Conservative (bucket-upper-bound) p95 latency across the executor's skills. */
  latencyP95(executorId: string): number | undefined {
    const stats = this.#aggregate(executorId).stats;
    if (stats.length === 0) return undefined;
    const merged = stats.reduce(
      (acc, s) => ({
        counts: acc.counts.map((c, i) => c + (s.latency.counts[i] ?? 0)),
        sum: acc.sum + s.latency.sum,
        count: acc.count + s.latency.count,
      }),
      { counts: new Array<number>(stats[0]!.latency.counts.length).fill(0), sum: 0, count: 0 },
    );
    return histogramPercentile(merged, 0.95);
  }

  meanCost(executorId: string): number | undefined {
    const stats = this.#aggregate(executorId).stats;
    const count = stats.reduce((n, s) => n + s.successCount + s.failureCount, 0);
    if (count === 0) return undefined;
    return stats.reduce((sum, s) => sum + s.totalCostUsd, 0) / count;
  }

  calibrate(selfReported: number, executorId: string, skill: string, kind: ExecutorKind): number {
    if (kind === 'verifier') return 1;
    return this.#calibrator.calibrate(selfReported, this.estimate(executorId, skill, kind));
  }

  /** Idempotent per attempt; updates the local cache only when the store accepted it. */
  async record(outcome: ExecutorOutcome): Promise<boolean> {
    const recorded = await this.#repo.recordOutcome(outcome);
    if (recorded) {
      const all = await this.#repo.executorStats();
      const updated = all.find((s) => s.executorId === outcome.executorId && s.skill === outcome.skill);
      if (updated !== undefined) this.#stats.set(key(updated.executorId, updated.skill), updated);
    }
    return recorded;
  }
}

function key(executorId: string, skill: string): string {
  return `${executorId}\u0000${skill}`;
}
