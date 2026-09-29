import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  affordability,
  canonicalJson,
  deadlineSignal,
  DeadlineReached,
  digestOf,
  emptyHistogram,
  histogramPercentile,
  isOverBudget,
  mulberry32,
  observeLatency,
  percentile,
  RandomIdGenerator,
  reliabilityEstimate,
  SecretValue,
  seedFrom,
  sleep,
  systemClock,
  tierClears,
  traceparent,
  TraceId,
  uuidv5,
  uuidv7,
  wilsonLowerBound,
  ZERO_SPEND,
  type Budget,
} from '@dvo/core';
import { FakeClock } from '@dvo/testkit';

describe('canonical JSON and digests', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
  });

  it('rejects values that have no canonical form', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});

describe('identifiers', () => {
  it('uuidv5 matches the RFC 9562 test vector', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('uuidv7 is versioned and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('generates prefixed ids and W3C trace ids', () => {
    const ids = new RandomIdGenerator(systemClock);
    expect(ids.taskId()).toMatch(/^tsk_/);
    expect(ids.traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(traceparent(TraceId('a'.repeat(32)), 'b'.repeat(16))).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });
});

describe('budget admission', () => {
  const budget: Budget = {
    maxCostUsd: 1,
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    maxRemoteCalls: 2,
    maxParallelAttempts: 2,
    deadlineAt: '2026-01-01T00:10:00.000Z',
  };

  it('counts in-flight reservations so parallel attempts cannot jointly overshoot', () => {
    const reserved = { ...ZERO_SPEND, costUsd: 0.6, remoteCalls: 1 };
    expect(affordability(budget, ZERO_SPEND, reserved, { costUsd: 0.3, remoteCalls: 1 })).toEqual({ ok: true });
    expect(affordability(budget, ZERO_SPEND, reserved, { costUsd: 0.5, remoteCalls: 0 })).toEqual({ ok: false, dimension: 'cost' });
    expect(affordability(budget, ZERO_SPEND, reserved, { costUsd: 0, remoteCalls: 2 })).toEqual({ ok: false, dimension: 'remote_calls' });
  });

  it('flags committed spend beyond a hard limit', () => {
    expect(isOverBudget(budget, { ...ZERO_SPEND, costUsd: 1 })).toBe(false);
    expect(isOverBudget(budget, { ...ZERO_SPEND, costUsd: 1.01 })).toBe(true);
  });
});

describe('reliability statistics', () => {
  it('lower bound is below the mean and tightens with evidence', () => {
    const few = reliabilityEstimate(8, 2, { alpha: 1, beta: 1 });
    const many = reliabilityEstimate(80, 20, { alpha: 1, beta: 1 });
    expect(few.lcb).toBeLessThan(few.mean);
    expect(many.mean - many.lcb).toBeLessThan(few.mean - few.lcb);
    expect(reliabilityEstimate(0, 0, { alpha: 1, beta: 1 }).n).toBe(0);
    expect(wilsonLowerBound(0.5, 0, 1.28)).toBe(0);
  });

  it('histogram percentiles are conservative bucket bounds', () => {
    let h = emptyHistogram();
    for (const v of [40, 60, 90, 400, 3000]) h = observeLatency(h, v);
    expect(histogramPercentile(h, 0.5)).toBe(100);
    expect(histogramPercentile(h, 0.99)).toBe(5000);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  it('seeded PRNG is reproducible', () => {
    const a = mulberry32(seedFrom('x'));
    const b = mulberry32(seedFrom('x'));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('classification clearance', () => {
  it('never clears secret data and respects rank order', () => {
    expect(tierClears('restricted', 'secret')).toBe(false);
    expect(tierClears('internal', 'public')).toBe(true);
    expect(tierClears('public', 'internal')).toBe(false);
  });
});

describe('SecretValue', () => {
  it('never stringifies its value', () => {
    const secret = new SecretValue('sk-live-123');
    expect(String(secret)).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect(secret)).not.toContain('sk-live');
    expect(secret.reveal()).toBe('sk-live-123');
  });
});

describe('clock utilities', () => {
  it('sleep and deadline signals run on the injected clock', async () => {
    const clock = new FakeClock(0);
    let woke = false;
    const sleeping = sleep(clock, 100).then(() => (woke = true));
    await clock.advance(99);
    expect(woke).toBe(false);
    await clock.advance(1);
    await sleeping;
    expect(woke).toBe(true);

    const { signal, dispose } = deadlineSignal(clock, 50);
    await clock.advance(50);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DeadlineReached);
    dispose();
  });

  it('an aborted sleep rejects', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const p = sleep(clock, 1000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(clock.pendingTimers).toBe(0);
  });
});
