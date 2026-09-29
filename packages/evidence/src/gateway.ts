import type { Correlation, EvidenceEnvelope, EvidenceTier, ExecutorKind, InjectionRisk } from '@dvo/core';
import { type ArtifactPolicy, type ArtifactRejectReason, checkArtifactRef } from './artifact.ts';
import { assessInjection, envelopeTexts, type InjectionAssessment } from './injection.ts';
import type { Redactor } from './redaction.ts';

export interface IngestContext {
  source: ExecutorKind;
  executorId: string;
  correlation: Correlation;
  /** Highest tier the producer can legitimately deliver (e.g. 0 for peers without the extension). */
  maxTier: EvidenceTier;
  /** Required when the producer is remote; artifact references are checked against it. */
  artifactPolicy?: ArtifactPolicy;
}

export interface IngestResult {
  envelope: EvidenceEnvelope;
  issues: string[];
  injection: InjectionAssessment;
  /** High injection risk: route to isolated verifiers only, never into a prompt. */
  quarantined: boolean;
  redactionHits: number;
  demotedClaims: number;
  artifactRejections: Array<{ uri?: string; reason: ArtifactRejectReason }>;
}

/**
 * Trust boundary for evidence (design §6.3). Bridges have already checked structure; this
 * decides what the evidence is allowed to *claim*:
 *  - only a local verifier may mark a claim `verified` (others are demoted to `supported`);
 *  - tiers above what the channel supports are downgraded, dropping artifacts;
 *  - artifact references failing the peer's policy are removed before anyone fetches them;
 *  - every string is redacted; injection-risky content is quarantined.
 */
export class EvidenceGateway {
  readonly #redactor: Redactor;

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  ingest(envelope: EvidenceEnvelope, ctx: IngestContext): IngestResult {
    const issues: string[] = [];
    let demotedClaims = 0;
    const artifactRejections: IngestResult['artifactRejections'] = [];

    let tier = envelope.tier;
    if (tier > ctx.maxTier) {
      issues.push(`tier ${tier} downgraded to ${ctx.maxTier}`);
      tier = ctx.maxTier;
    }

    const claims = envelope.claims.map((claim) => {
      const confidence = Math.min(1, Math.max(0, claim.confidence));
      if (claim.status === 'verified' && ctx.source !== 'verifier') {
        demotedClaims += 1;
        return { ...claim, confidence, status: 'supported' as const };
      }
      return { ...claim, confidence };
    });
    if (demotedClaims > 0) issues.push(`${demotedClaims} self-verified claim(s) demoted to supported`);

    const evidence = envelope.evidence.filter((item) => {
      const isArtifact = item.kind === 'artifact' || item.uri !== undefined;
      if (!isArtifact) return true;
      if (tier < 2 && item.kind === 'artifact') {
        artifactRejections.push({ ...(item.uri === undefined ? {} : { uri: item.uri }), reason: 'tier_not_supported' });
        issues.push('artifact dropped: channel does not carry tier-2 evidence');
        return false;
      }
      if (ctx.source === 'dsh-local' || ctx.source === 'verifier') {
        // Local producers may cite local provenance, but never file:// or other local URIs outward.
        return item.uri === undefined || /^https:\/\//i.test(item.uri);
      }
      const check = checkArtifactRef(
        item,
        ctx.artifactPolicy ?? { allowedHosts: [], allowedMimeTypes: [], maxBytes: 0, requireSha256: true },
      );
      if (!check.ok) {
        artifactRejections.push({ ...(item.uri === undefined ? {} : { uri: item.uri }), reason: check.reason });
        issues.push(`artifact reference rejected: ${check.reason}`);
        return false;
      }
      return true;
    });

    const candidate: EvidenceEnvelope = { ...envelope, tier, claims, evidence, correlation: ctx.correlation };
    const redacted = this.#redactor.redact(candidate);
    const sanitised: EvidenceEnvelope = {
      ...redacted.value,
      correlation: ctx.correlation,
      redactionApplied: envelope.redactionApplied || redacted.hits > 0,
    };
    if (redacted.hits > 0) issues.push(`${redacted.hits} redaction(s) applied`);

    const injection =
      ctx.source === 'verifier' ? { level: 'low' as InjectionRisk, score: 0, signals: [] } : assessInjection(envelopeTexts(sanitised));
    if (injection.level !== 'low') issues.push(`prompt-injection risk ${injection.level}: ${injection.signals.join(', ')}`);

    return {
      envelope: sanitised,
      issues,
      injection,
      quarantined: injection.level === 'high',
      redactionHits: redacted.hits,
      demotedClaims,
      artifactRejections,
    };
  }
}
