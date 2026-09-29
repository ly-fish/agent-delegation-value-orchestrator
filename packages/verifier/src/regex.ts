import { ANSWER_CLAIM_ID, ValidationError, type VerificationInput, type VerificationOutcome, type Verifier } from '@dvo/core';

/**
 * Checks the answer claim against a regular expression fixed in local configuration
 * (a peer can never supply the pattern). Patterns are length-limited and the subject
 * truncated to bound backtracking cost.
 */
export class RegexVerifier implements Verifier {
  readonly id: string;
  readonly deterministic = true;
  readonly #pattern: RegExp;
  readonly #maxSubject: number;

  constructor(id: string, pattern: string, flags = '', maxSubject = 10_000) {
    if (pattern.length > 500) throw new ValidationError('regex verifier pattern too long');
    this.id = id;
    this.#pattern = new RegExp(pattern, flags.replace(/[gy]/g, ''));
    this.#maxSubject = maxSubject;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async verify(input: VerificationInput): Promise<VerificationOutcome> {
    const claimId = typeof input.spec.params?.['claimId'] === 'string' ? input.spec.params['claimId'] : ANSWER_CLAIM_ID;
    const claim = input.candidate.claims.find((c) => c.id === claimId);
    if (claim === undefined) return { outcome: 'refuted', claimVerdicts: [], detail: `no claim with id "${claimId}"` };
    const ok = this.#pattern.test(claim.statement.slice(0, this.#maxSubject));
    return { outcome: ok ? 'verified' : 'refuted', claimVerdicts: [{ claimId, verdict: ok ? 'verified' : 'refuted' }] };
  }
}
