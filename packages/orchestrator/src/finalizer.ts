import {
  type AttemptState,
  attemptsOf,
  type FinalOutcome,
  type FinalVerificationStatus,
  isCandidateResult,
  primaryClaim,
  type StopReason,
  type TaskState,
  type TerminalTaskPhase,
  toIso,
} from '@dvo/core';
import { statementDigest } from '@dvo/evidence';

export type FinalizeReason = StopReason | 'cancelled';

/**
 * Chooses the task's final answer (design §4 `Finalizer`, §10.2, §16.1).
 *  - A verified answer always wins and is labelled `verified`.
 *  - With a verifier configured but no verified answer, the best candidate is reported as
 *    `unverified` best effort; the task only succeeds that way if the verifier itself was
 *    unavailable (degraded) — never by quietly skipping verification.
 *  - Without a verifier, the best calibrated answer is `supported` when two independent
 *    executors agree on it and `proposed` otherwise.
 *  - Budget, deadline or safety stops without an acceptable answer fail explicitly.
 */
export function finalOutcome(state: TaskState, reason: FinalizeReason, nowMs: number, detail: string): FinalOutcome {
  const finalizedAt = toIso(nowMs);
  const candidates = attemptsOf(state).filter(isCandidateResult);
  const best = pickBest(candidates);

  if (reason === 'cancelled') {
    return { status: 'cancelled', verificationStatus: 'unverified', reason: detail, finalizedAt };
  }

  const verified = pickBest(candidates.filter((a) => a.verification === 'verified'));
  if (verified !== undefined)
    return withAnswer({ status: 'succeeded', verificationStatus: 'verified', reason: detail, finalizedAt }, verified);

  const failedStatus: TerminalTaskPhase = reason === 'deadline' ? 'expired' : 'failed';
  if (state.verification !== undefined) {
    if (best === undefined)
      return { status: failedStatus, verificationStatus: 'unverified', reason: detail || 'no acceptable result', finalizedAt };
    const degraded = state.degradedReasons.length > 0 && best.verification === 'unverified';
    const status: TerminalTaskPhase = degraded && reason === 'sufficient_evidence' ? 'succeeded' : failedStatus;
    return withAnswer(
      { status, verificationStatus: 'unverified', reason: degraded ? `${detail}; verifier unavailable` : detail, finalizedAt },
      best,
    );
  }

  if (best === undefined)
    return { status: failedStatus, verificationStatus: 'unverified', reason: detail || 'no acceptable result', finalizedAt };
  return withAnswer({ status: 'succeeded', verificationStatus: agreementStatus(best, candidates), reason: detail, finalizedAt }, best);
}

function pickBest(candidates: readonly AttemptState[]): AttemptState | undefined {
  return [...candidates].sort(
    (a, b) =>
      (b.result?.calibratedConfidence ?? 0) - (a.result?.calibratedConfidence ?? 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
  )[0];
}

function agreementStatus(best: AttemptState, candidates: readonly AttemptState[]): FinalVerificationStatus {
  const claim = primaryClaim(best.result?.output);
  if (claim === undefined) return 'proposed';
  const digest = statementDigest(claim.statement);
  const agreeing = new Set(
    candidates
      .filter((a) => {
        const other = primaryClaim(a.result?.output);
        return other !== undefined && statementDigest(other.statement) === digest;
      })
      .map((a) => a.executorId),
  );
  if (agreeing.size >= 2) return 'supported';
  const hasEvidence = (best.result?.output?.evidence.length ?? 0) > 0;
  return hasEvidence && claim.status === 'supported' ? 'supported' : 'proposed';
}

function withAnswer(outcome: FinalOutcome, attempt: AttemptState): FinalOutcome {
  const claim = primaryClaim(attempt.result?.output);
  return {
    ...outcome,
    finalAttemptId: attempt.attemptId,
    ...(claim === undefined ? {} : { answer: { claimId: claim.id, statement: claim.statement } }),
  };
}
