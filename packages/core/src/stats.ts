import type { ReliabilityEstimate } from './policy-input.ts';

export interface BetaPrior {
  alpha: number;
  beta: number;
}

/**
 * Posterior reliability of an executor from success/failure counts and a Beta prior.
 * The lower bound is the Wilson score interval over the posterior pseudo-counts, a
 * conservative, closed-form stand-in for the Beta quantile that behaves well at small n.
 */
export function reliabilityEstimate(
  successes: number,
  failures: number,
  prior: BetaPrior,
  z = 1.2816, // one-sided 90 %
): ReliabilityEstimate {
  const s = Math.max(0, successes) + prior.alpha;
  const f = Math.max(0, failures) + prior.beta;
  const n = s + f;
  const mean = s / n;
  return { mean, lcb: wilsonLowerBound(mean, n, z), n: Math.max(0, successes) + Math.max(0, failures) };
}

export function wilsonLowerBound(p: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** Upper bounds (ms) of the latency histogram buckets; the final bucket is +Inf. */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface LatencyHistogramData {
  /** counts[i] = observations <= LATENCY_BUCKETS_MS[i]; the last element counts the +Inf bucket. */
  counts: number[];
  sum: number;
  count: number;
}

export function emptyHistogram(): LatencyHistogramData {
  return { counts: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 };
}

export function observeLatency(h: LatencyHistogramData, valueMs: number): LatencyHistogramData {
  const counts = [...h.counts];
  let index = LATENCY_BUCKETS_MS.findIndex((bound) => valueMs <= bound);
  if (index === -1) index = LATENCY_BUCKETS_MS.length;
  counts[index] = (counts[index] ?? 0) + 1;
  return { counts, sum: h.sum + valueMs, count: h.count + 1 };
}

/** Bucket-upper-bound percentile estimate (conservative: never under-estimates tail latency). */
export function histogramPercentile(h: LatencyHistogramData, q: number): number | undefined {
  if (h.count === 0) return undefined;
  const target = Math.ceil(q * h.count);
  let cumulative = 0;
  for (let i = 0; i < h.counts.length; i++) {
    cumulative += h.counts[i] ?? 0;
    if (cumulative >= target) return LATENCY_BUCKETS_MS[i] ?? LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]! * 2;
  }
  return undefined;
}

/** Exact percentile of raw samples (nearest-rank). */
export function percentile(samples: readonly number[], q: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
}

/** Small deterministic PRNG (mulberry32) for reproducible exploration and simulations. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit seed from a string (FNV-1a). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
