import { ANSWER_CLAIM_ID, ValidationError, type VerificationInput, type VerificationOutcome, type Verifier } from '@dvo/core';
import { normalizeStatement } from '@dvo/evidence';

/**
 * Compares the answer claim with an expected value held locally (never sent to executors).
 * Numbers compare with an absolute/relative tolerance; text compares after normalisation.
 * params: { expected: string | number; tolerance?: number; claimId?: string; caseSensitive?: boolean }
 */
export class ExactAnswerVerifier implements Verifier {
  readonly id: string;
  readonly deterministic = true;

  constructor(id = 'exact-answer') {
    this.id = id;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async verify(input: VerificationInput): Promise<VerificationOutcome> {
    const params = input.spec.params ?? {};
    const expected = params['expected'];
    if (typeof expected !== 'string' && typeof expected !== 'number') {
      throw new ValidationError('exact-answer verifier needs params.expected');
    }
    const claimId = typeof params['claimId'] === 'string' ? params['claimId'] : ANSWER_CLAIM_ID;
    const tolerance = typeof params['tolerance'] === 'number' ? params['tolerance'] : 1e-9;
    const claim = input.candidate.claims.find((c) => c.id === claimId);
    if (claim === undefined) {
      return { outcome: 'refuted', claimVerdicts: [], detail: `no claim with id "${claimId}"` };
    }
    const ok = matches(claim.statement, expected, tolerance, params['caseSensitive'] === true);
    return {
      outcome: ok ? 'verified' : 'refuted',
      claimVerdicts: [{ claimId, verdict: ok ? 'verified' : 'refuted' }],
      detail: ok ? 'answer matches the expected value' : 'answer does not match the expected value',
    };
  }
}

export function matches(statement: string, expected: string | number, tolerance: number, caseSensitive: boolean): boolean {
  const actualNorm = normalizeStatement(statement);
  const expectedNorm = normalizeStatement(String(expected));
  const a = Number(actualNorm);
  const e = Number(expectedNorm);
  if (actualNorm !== '' && expectedNorm !== '' && Number.isFinite(a) && Number.isFinite(e)) {
    return Math.abs(a - e) <= Math.max(tolerance, tolerance * Math.abs(e));
  }
  if (caseSensitive) return statement.trim().replace(/\s+/g, ' ') === String(expected).trim().replace(/\s+/g, ' ');
  return actualNorm === expectedNorm;
}
