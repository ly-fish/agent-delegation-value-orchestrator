/**
 * Task hardness profile (design §5.3). These are *features*, not ground truth: the MVP
 * fills them heuristically and later versions calibrate them from traces. No policy may
 * scale the number of agents from `reasoningDepth` alone.
 */
export interface HardnessProfile {
  /** 0..1 normalised estimate of critical-path / step complexity. */
  reasoningDepth: number;
  /** 0..1 span of tools, domains and model capabilities needed. */
  skillBreadth: number;
  /** 0..1; high means sub-problems cannot be solved independently (poor fit for black-box peers). */
  dependencyCoupling: number;
  /** 0..1; how scattered the required information is. */
  informationFragmentation: number;
  /** 0..1 */
  ambiguity: number;
  /** 0..1; high means a reliable automatic verifier exists. */
  verifiability: number;
  /** 0..1 posterior failure risk from the execution trajectory so far. */
  currentFailureRisk: number;
  confidenceSource: 'heuristic' | 'calibrated-model' | 'manual';
}

/** Optional caller-supplied hints that the heuristic estimator folds in. */
export interface HardnessHints {
  subtaskCount?: number;
  criticalPathLength?: number;
  requiredSkills?: readonly string[];
  independentSubtasks?: boolean;
  /** Manual override; wins over the heuristic for every field it sets. */
  profile?: Partial<Omit<HardnessProfile, 'confidenceSource'>>;
}

export function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export const NEUTRAL_HARDNESS: Readonly<HardnessProfile> = Object.freeze({
  reasoningDepth: 0.5,
  skillBreadth: 0.3,
  dependencyCoupling: 0.5,
  informationFragmentation: 0.3,
  ambiguity: 0.3,
  verifiability: 0,
  currentFailureRisk: 0.3,
  confidenceSource: 'heuristic',
});
