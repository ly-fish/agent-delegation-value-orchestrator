/**
 * Data classification (design §12.1). The rank order matters: a peer cleared for
 * `internal` may receive `public` and `internal` data, never `restricted` or `secret`.
 */
export const DATA_CLASSIFICATIONS = ['public', 'internal', 'restricted', 'secret'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

/**
 * A peer's trust tier is the highest classification it is cleared to receive.
 * `restricted` clearance is necessary but not sufficient: a human approval is also required.
 * Nothing is ever cleared for `secret`.
 */
export const TRUST_TIERS = ['public', 'internal', 'restricted'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export function classificationRank(value: DataClassification): number {
  return DATA_CLASSIFICATIONS.indexOf(value);
}

export function maxClassification(a: DataClassification, b: DataClassification): DataClassification {
  return classificationRank(a) >= classificationRank(b) ? a : b;
}

/** True when a peer with `tier` clearance may receive data of `classification`. */
export function tierClears(tier: TrustTier, classification: DataClassification): boolean {
  if (classification === 'secret') return false;
  return classificationRank(tier) >= classificationRank(classification);
}
