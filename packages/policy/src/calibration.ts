import type { ReliabilityEstimate } from '@dvo/core';

/**
 * Maps a producer's self-reported confidence to a probability of being correct. Self-reports
 * are only a weak signal (design §6.2, §17): they are shrunk towards the executor's observed
 * reliability, and the more history there is, the less the self-report counts.
 */
export interface Calibrator {
  readonly id: string;
  calibrate(selfReported: number, reliability: ReliabilityEstimate): number;
}

export class ShrinkageCalibrator implements Calibrator {
  readonly id = 'shrinkage/1';
  readonly #weight: number;
  readonly #halfLife: number;

  /**
   * @param weight weight on the self-report when there is no history
   * @param halfLife number of observations at which that weight halves
   */
  constructor(weight = 0.3, halfLife = 10) {
    this.#weight = weight;
    this.#halfLife = halfLife;
  }

  calibrate(selfReported: number, reliability: ReliabilityEstimate): number {
    const w = this.#weight / (1 + reliability.n / this.#halfLife);
    const self = Math.min(1, Math.max(0, Number.isFinite(selfReported) ? selfReported : 0));
    return Math.min(1, Math.max(0, w * self + (1 - w) * reliability.mean));
  }
}

/** Platt scaling p = σ(a·logit(c) + b), fitted by Newton's method on logged (confidence, correct) pairs. */
export class PlattCalibrator implements Calibrator {
  readonly id: string;
  readonly a: number;
  readonly b: number;

  constructor(a: number, b: number) {
    this.a = a;
    this.b = b;
    this.id = `platt/${a.toFixed(3)},${b.toFixed(3)}`;
  }

  /**
   * Maximum-likelihood fit with Platt's label smoothing, started from the base rate
   * (a = 0, b = logit(rate)) and damped by a backtracking line search, so saturated inputs
   * (every self-report near 1) cannot make Newton steps diverge.
   */
  static fit(samples: ReadonlyArray<{ confidence: number; correct: boolean }>, iterations = 100): PlattCalibrator {
    if (samples.length < 2) return new PlattCalibrator(1, 0);
    const xs = samples.map((s) => logit(s.confidence));
    const positives = samples.filter((s) => s.correct).length;
    const negatives = samples.length - positives;
    const hi = (positives + 1) / (positives + 2);
    const lo = 1 / (negatives + 2);
    const ys = samples.map((s) => (s.correct ? hi : lo));
    const loss = (a: number, b: number): number =>
      xs.reduce((sum, x, i) => {
        const z = a * x + b;
        // log(1 + e^z) - y·z, computed stably
        return sum + (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - ys[i]! * z;
      }, 0);
    let a = 0;
    let b = logit(positives / samples.length);
    let current = loss(a, b);
    for (let it = 0; it < iterations; it++) {
      let ga = 0,
        gb = 0,
        haa = 1e-9,
        hab = 0,
        hbb = 1e-9;
      for (let i = 0; i < xs.length; i++) {
        const p = sigmoid(a * xs[i]! + b);
        const d = p - ys[i]!;
        const w = p * (1 - p);
        ga += d * xs[i]!;
        gb += d;
        haa += w * xs[i]! * xs[i]!;
        hab += w * xs[i]!;
        hbb += w;
      }
      const det = haa * hbb - hab * hab;
      if (Math.abs(det) < 1e-12) break;
      const da = (hbb * ga - hab * gb) / det;
      const db = (haa * gb - hab * ga) / det;
      let step = 1;
      let next = loss(a - da, b - db);
      while (next > current && step > 1e-6) {
        step /= 2;
        next = loss(a - step * da, b - step * db);
      }
      if (next > current) break;
      a -= step * da;
      b -= step * db;
      const improvement = current - next;
      current = next;
      if (improvement < 1e-10) break;
    }
    return new PlattCalibrator(a, b);
  }

  calibrate(selfReported: number): number {
    return sigmoid(this.a * logit(selfReported) + this.b);
  }
}

function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Expected calibration error over equal-width bins (for calibration reports). */
export function expectedCalibrationError(samples: ReadonlyArray<{ predicted: number; correct: boolean }>, bins = 10): number {
  if (samples.length === 0) return 0;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const inBin = samples.filter((s) => Math.min(bins - 1, Math.floor(s.predicted * bins)) === b);
    if (inBin.length === 0) continue;
    const confidence = inBin.reduce((sum, s) => sum + s.predicted, 0) / inBin.length;
    const accuracy = inBin.filter((s) => s.correct).length / inBin.length;
    ece += (inBin.length / samples.length) * Math.abs(confidence - accuracy);
  }
  return ece;
}
