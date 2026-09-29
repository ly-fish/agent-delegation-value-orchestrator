import { clampUnit, type HardnessHints, type HardnessProfile } from '@dvo/core';

export interface HardnessInput {
  goal: string;
  requiredSkills: readonly string[];
  hasVerifier: boolean;
  hints?: HardnessHints;
}

const STEP_MARKERS = /\b(then|after that|next|finally|subsequently|step \d+|first,|second,|third,)\b|^\s*\d+[.)]\s/gim;
const VAGUE_MARKERS = /\b(maybe|roughly|approximately|somehow|something like|etc\.?|and so on|best|nice|good enough)\b|[?？]/gi;
const SOURCE_MARKERS = /\bhttps?:\/\/|\b(sources?|references?|documents?|papers?|datasets?)\b/gi;

/**
 * Heuristic hardness profile for MVP routing (design §5.3). Deliberately simple and
 * transparent; `confidenceSource` says so. Caller hints and manual overrides win.
 */
export function estimateHardness(input: HardnessInput): HardnessProfile {
  const { goal, hints } = input;
  const steps = (goal.match(STEP_MARKERS) ?? []).length;
  const vague = (goal.match(VAGUE_MARKERS) ?? []).length;
  const sources = (goal.match(SOURCE_MARKERS) ?? []).length;
  const skills = new Set([...input.requiredSkills, ...(hints?.requiredSkills ?? [])]);

  const depthFromHints = hints?.criticalPathLength === undefined ? undefined : hints.criticalPathLength / 10;
  const reasoningDepth = clampUnit(depthFromHints ?? Math.min(1, goal.length / 3000) * 0.5 + Math.min(1, steps / 6) * 0.5);

  // Coupling semantics: ≤ 0.45 parallelisable, ≤ 0.75 delegable as a whole, above that tied to
  // local context. "Sub-tasks are not independent" rules out parallel decomposition, not
  // handing a self-contained task to one peer; only a manual override marks context coupling.
  let dependencyCoupling = 0.5;
  if (hints?.independentSubtasks === true) dependencyCoupling = 0.2;
  else if (hints?.independentSubtasks === false) dependencyCoupling = 0.6;

  const heuristic: HardnessProfile = {
    reasoningDepth,
    skillBreadth: clampUnit(skills.size / 5),
    dependencyCoupling,
    informationFragmentation: clampUnit(sources / 5 + ((hints?.subtaskCount ?? 1) > 1 ? 0.1 : 0)),
    ambiguity: clampUnit(vague / 4 + (goal.trim().length < 40 ? 0.3 : 0)),
    verifiability: input.hasVerifier ? 1 : 0,
    currentFailureRisk: 0.3,
    confidenceSource: 'heuristic',
  };

  const manual = hints?.profile;
  if (manual === undefined) return heuristic;
  const merged: HardnessProfile = { ...heuristic };
  for (const [key, value] of Object.entries(manual) as Array<[keyof typeof manual, number | undefined]>) {
    if (value !== undefined) merged[key] = clampUnit(value);
  }
  const complete = Object.keys(manual).length >= 7;
  return { ...merged, confidenceSource: complete ? 'manual' : 'heuristic' };
}

/** Posterior failure risk from the trajectory so far: failures and refutations raise it. */
export function updateFailureRisk(
  profile: HardnessProfile,
  trajectory: { failed: number; refuted: number; completed: number },
): HardnessProfile {
  const base = 0.3;
  const risk = clampUnit(base + 0.15 * trajectory.failed + 0.25 * trajectory.refuted - 0.1 * trajectory.completed);
  return { ...profile, currentFailureRisk: risk };
}
