import { sha256Hex, type EvidenceEnvelope } from '@dvo/core';

/**
 * Canonical form of a claim statement for agreement checks: Unicode NFKC, case-folded,
 * whitespace collapsed, trailing sentence punctuation dropped, numbers canonicalised
 * ("42.0", "+42" and "42" compare equal).
 */
export function normalizeStatement(statement: string): string {
  let s = statement.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/[.!?;。！？；]+$/u, '').trim();
  const numeric = s.replace(/,(?=\d{3}\b)/g, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(numeric)) {
    const value = Number(numeric);
    if (Number.isFinite(value)) return String(value);
  }
  return s;
}

export function statementDigest(statement: string): string {
  return sha256Hex(normalizeStatement(statement));
}

/** Claim id → digest of its normalised statement. Lets the policy compare answers blind. */
export function claimDigests(envelope: EvidenceEnvelope | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const claim of envelope?.claims ?? []) out[claim.id] = statementDigest(claim.statement);
  return out;
}

export interface ClaimConflict<K extends string = string> {
  claimId: string;
  sources: [K, K];
}

/** Pairs of sources that answer the same claim id differently. */
export function detectConflicts<K extends string>(
  sources: ReadonlyArray<{ key: K; claimDigests: Record<string, string> }>,
): ClaimConflict<K>[] {
  const conflicts: ClaimConflict<K>[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i]!;
      const b = sources[j]!;
      for (const [claimId, digest] of Object.entries(a.claimDigests)) {
        const other = b.claimDigests[claimId];
        if (other !== undefined && other !== digest) conflicts.push({ claimId, sources: [a.key, b.key] });
      }
    }
  }
  return conflicts;
}
