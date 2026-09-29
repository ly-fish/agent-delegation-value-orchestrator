import { describe, expect, it } from 'vitest';
import { runBenchmark } from './benchmark.ts';
import { generateTasks } from './tasks.ts';

const options = { tasks: 30, seed: 11, budget: { maxCostUsd: 0.06, maxRemoteCalls: 3, maxParallelAttempts: 3, deadlineMs: 90_000 } };

describe('controlled-DAG benchmark', () => {
  it('generates reproducible, exactly-scored tasks', () => {
    const a = generateTasks(5, 3);
    expect(generateTasks(5, 3)).toEqual(a);
    expect(a[0]!.goal).toMatch(/^\[dag-3-0\] Given /);
    expect(Number.isFinite(a[0]!.answer)).toBe(true);
  });

  it('is deterministic, compute-matched and never violates the budget', async () => {
    const first = await runBenchmark(options);
    const second = await runBenchmark(options);
    expect(second.summaries).toEqual(first.summaries);
    for (const s of first.summaries) expect(s.budgetViolations).toBe(0);
    const byName = Object.fromEntries(first.summaries.map((s) => [s.strategy, s]));
    const dvo = byName['DVO (value $1 / success)']!;
    const local = byName['single-agent (local only)']!;
    expect(dvo.successRate).toBeGreaterThanOrEqual(local.successRate);
    expect(first.summaries.some((s) => s.pareto)).toBe(true);
  }, 120_000);
});
