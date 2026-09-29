import type { Correlation } from './correlation.ts';

/**
 * Evidence tiers (design §6.1).
 * 0: summary — conclusion, constraints, next-step request.
 * 1: claim/evidence — locatable claims, source/tool summaries, confidence, dependencies.
 * 2: reproducible — artifact digests, verification recipes, provenance.
 */
export type EvidenceTier = 0 | 1 | 2;

export const EVIDENCE_SCHEMA_VERSION = '1.0';

export type ClaimStatus = 'proposed' | 'supported' | 'verified' | 'refuted';

export interface Claim {
  /**
   * Stable key of the question the claim answers. Claims with equal ids from different
   * attempts are about the same thing, which is how conflicts are detected.
   * By convention the primary answer uses id `answer`.
   */
  id: string;
  statement: string;
  /** Self-reported by the producer; only ever used as a weak signal. */
  confidence: number;
  assumptions: string[];
  dependencies: string[];
  status: ClaimStatus;
}

export type EvidenceKind = 'citation' | 'tool-result' | 'test-result' | 'artifact' | 'observation';

export interface EvidenceItem {
  kind: EvidenceKind;
  summary: string;
  uri?: string;
  sha256?: string;
  mimeType?: string;
  bytes?: number;
  /** Informational only. Never executed: verification recipes come from local configuration. */
  verifierHint?: string;
}

export interface EvidenceEnvelope {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  correlation: Correlation;
  tier: EvidenceTier;
  taskScope: string;
  claims: Claim[];
  evidence: EvidenceItem[];
  requestedNextAction?: string;
  redactionApplied: boolean;
}

/** Id of the claim that carries a task's primary answer. */
export const ANSWER_CLAIM_ID = 'answer';

export function primaryClaim(envelope: EvidenceEnvelope | undefined): Claim | undefined {
  if (envelope === undefined) return undefined;
  return envelope.claims.find((claim) => claim.id === ANSWER_CLAIM_ID) ?? envelope.claims[0];
}
