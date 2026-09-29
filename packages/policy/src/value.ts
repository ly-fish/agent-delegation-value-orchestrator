import type { PolicyInput, PolicyResultView } from '@dvo/core';

/**
 * Success probability of the task given independent candidate answers with probabilities `qs`.
 *
 * With a deterministic verifier (v = 1) any correct candidate can be identified, so the
 * task succeeds unless every candidate is wrong: 1 − ∏(1 − qᵢ). Without one (v = 0) the
 * final answer is chosen by calibrated confidence, so only the best candidate counts: max qᵢ.
 * Partial verifiability interpolates. (V1 deliberately ignores majority-vote aggregation.)
 */
export function successProbability(qs: readonly number[], verifiability: number): number {
  if (qs.length === 0) return 0;
  const clamped = qs.map((q) => Math.min(1, Math.max(0, q)));
  const anyCorrect = 1 - clamped.reduce((acc, q) => acc * (1 - q), 1);
  const best = Math.max(...clamped);
  const v = Math.min(1, Math.max(0, verifiability));
  return v * anyCorrect + (1 - v) * best;
}

/** Effective verifiability for decisions: 1 only when a deterministic verifier can actually run. */
export function effectiveVerifiability(input: PolicyInput): number {
  if (input.verifierId === undefined) return 0;
  const verifier = input.verifiers.find((v) => v.id === input.verifierId);
  return verifier?.available === true && verifier.deterministic ? 1 : 0;
}

/** Candidate answers still in play, with the probability each is correct. */
export function candidateProbabilities(results: readonly PolicyResultView[]): number[] {
  return results
    .filter((r) => r.terminalStatus === 'completed' && r.verification !== 'refuted')
    .map((r) => (r.verification === 'verified' ? 1 : r.calibratedConfidence));
}

/** Expected success probability of a fresh attempt, discounted for depth like every other executor. */
export function adjustForDepth(q: number, reasoningDepth: number, depthPenalty: number): number {
  return Math.min(1, Math.max(0, q * (1 - depthPenalty * Math.min(1, Math.max(0, reasoningDepth)))));
}

export interface PrimaryConflict {
  claimId: string;
  attemptIds: PolicyResultView['attemptId'][];
}

/** Completed, unrefuted results that disagree on the primary answer claim. */
export function primaryConflict(results: readonly PolicyResultView[]): PrimaryConflict | undefined {
  const live = results.filter((r) => r.terminalStatus === 'completed' && r.verification !== 'refuted');
  const byDigest = new Map<string, PolicyResultView['attemptId'][]>();
  for (const r of live) {
    const digest = r.claimDigests['answer'] ?? Object.values(r.claimDigests)[0];
    if (digest === undefined) continue;
    byDigest.set(digest, [...(byDigest.get(digest) ?? []), r.attemptId]);
  }
  if (byDigest.size < 2) return undefined;
  return { claimId: 'answer', attemptIds: [...byDigest.values()].flat() };
}
