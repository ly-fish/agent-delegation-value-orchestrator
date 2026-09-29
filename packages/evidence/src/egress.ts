import { type DataClassification, type EvidenceEnvelope, type EvidenceTier, tierClears, type TrustTier } from '@dvo/core';
import type { Redactor } from './redaction.ts';

export interface EgressTarget {
  peerId: string;
  trustTier: TrustTier;
  /** Peer runs in a sandbox approved for restricted data (still needs per-task approval). */
  allowRestricted: boolean;
  maxEvidenceTier: EvidenceTier;
}

export interface EgressInput {
  classification: DataClassification;
  restrictedDelegationApproved: boolean;
  /** Already-minimised task scope (the redacted goal). */
  taskScope: string;
  /** Prior evidence to share, when the action calls for it. */
  evidence?: EvidenceEnvelope;
  requestedTier: EvidenceTier;
}

export type EgressDecision =
  | {
      allowed: true;
      taskScope: string;
      evidence?: EvidenceEnvelope;
      tier: EvidenceTier;
      redactionApplied: boolean;
      classificationSent: DataClassification;
    }
  | { allowed: false; reason: 'secret' | 'classification' | 'approval_required' };

/**
 * Outbound data-minimisation gate (design §12). Remote peers receive the task scope and,
 * optionally, a tier-limited view of prior claims — never local context, tool output,
 * credentials, file URIs or chain-of-thought.
 */
export class EgressGuard {
  readonly #redactor: Redactor;

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  prepare(input: EgressInput, target: EgressTarget): EgressDecision {
    if (input.classification === 'secret') return { allowed: false, reason: 'secret' };
    if (input.classification === 'restricted') {
      if (!target.allowRestricted || target.trustTier !== 'restricted') return { allowed: false, reason: 'classification' };
      if (!input.restrictedDelegationApproved) return { allowed: false, reason: 'approval_required' };
    } else if (!tierClears(target.trustTier, input.classification)) {
      return { allowed: false, reason: 'classification' };
    }

    const tier = Math.min(input.requestedTier, target.maxEvidenceTier) as EvidenceTier;
    const scope = this.#redactor.redactText(input.taskScope);
    let hits = scope.hits;
    let evidence: EvidenceEnvelope | undefined;
    if (input.evidence !== undefined) {
      const minimised = minimise(input.evidence, tier);
      const redacted = this.#redactor.redact(minimised);
      hits += redacted.hits;
      evidence = { ...redacted.value, redactionApplied: minimised.redactionApplied || redacted.hits > 0 };
    }
    return {
      allowed: true,
      taskScope: scope.value,
      ...(evidence === undefined ? {} : { evidence }),
      tier,
      redactionApplied: hits > 0,
      classificationSent: input.classification,
    };
  }
}

/** Tier 0: claims only. Tier 1: plus evidence summaries. Tier 2: plus https artifact references. */
export function minimise(envelope: EvidenceEnvelope, tier: EvidenceTier): EvidenceEnvelope {
  const claims = envelope.claims.map((c) => (tier === 0 ? { ...c, assumptions: [], dependencies: [] } : { ...c }));
  const evidence =
    tier === 0
      ? []
      : envelope.evidence.flatMap((item) => {
          if (item.uri === undefined) {
            const { verifierHint: _hint, ...rest } = item;
            return [rest];
          }
          if (tier < 2 || !/^https:\/\//i.test(item.uri)) {
            const { uri: _uri, sha256: _sha, bytes: _bytes, verifierHint: _hint, ...rest } = item;
            return [rest];
          }
          const { verifierHint: _hint, ...rest } = item;
          return [rest];
        });
  const { requestedNextAction: _next, ...rest } = envelope;
  return { ...rest, tier, claims, evidence };
}
