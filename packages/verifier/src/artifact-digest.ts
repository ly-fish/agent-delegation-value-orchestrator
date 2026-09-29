import { sha256Hex, type VerificationInput, type VerificationOutcome, type Verifier } from '@dvo/core';

/** Read access to quarantined artifact bytes by digest (satisfied by QuarantineStore). */
export interface ArtifactBytes {
  get(sha256: string): Promise<Uint8Array | undefined>;
}

/**
 * Tier-2 provenance check: every artifact the envelope cites must be present in the
 * quarantine store and hash to its declared SHA-256. Any mismatch refutes the envelope;
 * an artifact that was never fetched makes the result inconclusive.
 */
export class ArtifactDigestVerifier implements Verifier {
  readonly id: string;
  readonly deterministic = true;
  readonly #store: ArtifactBytes;

  constructor(store: ArtifactBytes, id = 'artifact-digest') {
    this.id = id;
    this.#store = store;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async verify(input: VerificationInput): Promise<VerificationOutcome> {
    const artifacts = input.candidate.evidence.filter((e) => e.sha256 !== undefined);
    if (artifacts.length === 0) return { outcome: 'inconclusive', claimVerdicts: [], detail: 'no artifacts with digests' };
    let missing = 0;
    for (const item of artifacts) {
      const bytes = await this.#store.get(item.sha256!);
      if (bytes === undefined) {
        missing += 1;
        continue;
      }
      if (sha256Hex(bytes) !== item.sha256) {
        return { outcome: 'refuted', claimVerdicts: [], detail: 'artifact digest mismatch' };
      }
    }
    if (missing > 0) return { outcome: 'inconclusive', claimVerdicts: [], detail: `${missing} artifact(s) not in quarantine` };
    return {
      outcome: 'verified',
      claimVerdicts: input.candidate.claims.map((c) => ({ claimId: c.id, verdict: 'verified' as const })),
      detail: `${artifacts.length} artifact digest(s) verified`,
    };
  }
}
