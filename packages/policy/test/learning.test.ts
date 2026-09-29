import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@dvo/core';
import {
  actionKey,
  CoverageGatedPolicy,
  coverageReport,
  DvoRulePolicy,
  doublyRobust,
  estimateHardness,
  expectedCalibrationError,
  inverseProbabilityWeighting,
  type LoggedDecision,
  PlattCalibrator,
  selfNormalisedIpw,
  ShrinkageCalibrator,
  updateFailureRisk,
} from '@dvo/policy';
import { input, peer } from './fixtures.ts';

/** Synthetic bandit: action `b` is better; the logging policy picks uniformly. */
function logs(n: number): LoggedDecision[] {
  const random = mulberry32(42);
  return Array.from({ length: n }, () => {
    const action = random() < 0.5 ? 'a' : 'b';
    const reward = random() < (action === 'b' ? 0.8 : 0.3) ? 1 : 0;
    return { context: {}, action, propensity: 0.5, reward };
  });
}

describe('off-policy estimators (design §7.2)', () => {
  const data = logs(4000);
  const alwaysB = (_c: Record<string, number>, a: string) => (a === 'b' ? 1 : 0);

  it('IPS, SNIPS and DR recover the value of a deterministic target policy', () => {
    expect(inverseProbabilityWeighting(data, alwaysB).estimate).toBeCloseTo(0.8, 1);
    expect(selfNormalisedIpw(data, alwaysB).estimate).toBeCloseTo(0.8, 1);
    const biasedModel = () => 0.5; // DR stays unbiased with a wrong reward model
    expect(doublyRobust(data, alwaysB, biasedModel, () => ['a', 'b']).estimate).toBeCloseTo(0.8, 1);
  });

  it('coverage reports refuse thin or overlap-free data', () => {
    expect(coverageReport(data, alwaysB).ok).toBe(true);
    const thin = coverageReport(data.slice(0, 20), alwaysB);
    expect(thin.ok).toBe(false);
    expect(thin.reasons.join()).toMatch(/n=20/);
  });

  it('a learned model is only used when coverage is adequate', () => {
    const fallback = new DvoRulePolicy();
    const model = { version: 'm1', score: (_i: unknown, c: { action: { kind: string } }) => (c.action.kind === 'delegate' ? 10 : 0) };
    const i = input({ peers: [peer('p1', { reliability: { mean: 0.5, lcb: 0.1, n: 0 } })] });
    const gatedOff = new CoverageGatedPolicy(
      fallback,
      model,
      coverageReport(data.slice(0, 5), () => 1),
    );
    expect(gatedOff.decide(i).selected.kind).toBe(fallback.decide(i).selected.kind);
    expect(gatedOff.version).toBe(fallback.version);
    const gatedOn = new CoverageGatedPolicy(fallback, model, { ...coverageReport(data, alwaysB), ok: true });
    expect(gatedOn.version).toBe(`${fallback.version}+m1`);
  });

  it('canonical action keys', () => {
    expect(actionKey({ kind: 'parallel', peerIds: [peer('b').peerId, peer('a').peerId], evidenceTier: 1 })).toBe('parallel:a+b');
    expect(actionKey({ kind: 'stop', reason: 'budget' })).toBe('stop:budget');
  });
});

describe('calibration', () => {
  it('shrinks self-reports towards observed reliability, more so with history', () => {
    const c = new ShrinkageCalibrator(0.3, 10);
    const noHistory = c.calibrate(0.99, { mean: 0.5, lcb: 0.3, n: 0 });
    const history = c.calibrate(0.99, { mean: 0.5, lcb: 0.45, n: 100 });
    expect(noHistory).toBeGreaterThan(history);
    expect(history).toBeLessThan(0.6);
  });

  it('Platt scaling fixes an over-confident producer', () => {
    const random = mulberry32(3);
    const samples = Array.from({ length: 2000 }, () => {
      const confidence = 0.9 + random() * 0.1; // always claims ≥ 90 %
      return { confidence, correct: random() < 0.55 }; // right 55 % of the time
    });
    const platt = PlattCalibrator.fit(samples);
    const before = expectedCalibrationError(samples.map((s) => ({ predicted: s.confidence, correct: s.correct })));
    const after = expectedCalibrationError(samples.map((s) => ({ predicted: platt.calibrate(s.confidence), correct: s.correct })));
    expect(after).toBeLessThan(before / 3);
  });
});

describe('hardness heuristics (features, not truth)', () => {
  it('reflects hints, verifiers and manual overrides', () => {
    const h = estimateHardness({
      goal: 'First, parse. Then, compute. Finally, report?',
      requiredSkills: ['a', 'b'],
      hasVerifier: true,
      hints: { independentSubtasks: true },
    });
    expect(h.verifiability).toBe(1);
    expect(h.dependencyCoupling).toBe(0.2);
    expect(h.reasoningDepth).toBeGreaterThan(0);
    expect(h.confidenceSource).toBe('heuristic');
    const manual = estimateHardness({
      goal: 'x',
      requiredSkills: [],
      hasVerifier: false,
      hints: {
        profile: {
          reasoningDepth: 0.9,
          skillBreadth: 0,
          dependencyCoupling: 0,
          informationFragmentation: 0,
          ambiguity: 0,
          verifiability: 0,
          currentFailureRisk: 0,
        },
      },
    });
    expect(manual.confidenceSource).toBe('manual');
    expect(manual.reasoningDepth).toBe(0.9);
    expect(updateFailureRisk(h, { failed: 2, refuted: 1, completed: 0 }).currentFailureRisk).toBeGreaterThan(h.currentFailureRisk);
  });
});
