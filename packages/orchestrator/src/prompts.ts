import { attemptsOf, primaryClaim, type TaskState } from '@dvo/core';
import { renderEvidenceForPrompt } from '@dvo/evidence';

/**
 * Prompt for the local executor: the (redacted) goal, prior non-quarantined evidence
 * framed as untrusted data, and which earlier answers a verifier refuted.
 */
export function localPrompt(state: TaskState): string {
  const attempts = attemptsOf(state).filter((a) => a.executorKind !== 'verifier' && a.result?.output !== undefined);
  const evidence = renderEvidenceForPrompt(
    attempts
      .filter((a) => a.verification !== 'refuted')
      .map((a) => ({ label: a.peerId ?? a.executorId, envelope: a.result!.output!, quarantined: a.result!.quarantined })),
  );
  const refuted = attempts
    .filter((a) => a.verification === 'refuted' && !a.result!.quarantined)
    .map((a) => primaryClaim(a.result!.output)?.statement)
    .filter((s): s is string => s !== undefined)
    .map((s) => `- ${s.slice(0, 500)}`);
  return [
    `Task: ${state.userGoal}`,
    evidence,
    refuted.length === 0 ? '' : `These earlier answers were checked by a verifier and are wrong:\n${refuted.join('\n')}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

/** Prompt for a remote peer: the minimal task scope only (design §2.1, §12). */
export function peerPrompt(taskScope: string, nextTier?: 1 | 2): string {
  if (nextTier === undefined) return `Task: ${taskScope}`;
  return `Task: ${taskScope}\n\nProvide tier-${nextTier} evidence (sources, checks, reproducible artifacts) for the claims in the attached envelope, or correct them.`;
}
