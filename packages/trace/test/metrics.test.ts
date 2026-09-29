import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@dvo/trace';

describe('MetricsRegistry (Prometheus exposition)', () => {
  it('renders counters, gauges and histograms in text format 0.0.4', () => {
    const m = new MetricsRegistry();
    m.inc('dvo_tasks_total', { outcome: 'succeeded', verification: 'verified' });
    m.inc('dvo_tasks_total', { outcome: 'succeeded', verification: 'verified' }, 2);
    m.set('dvo_attempts_active', 3);
    m.observe('dvo_task_cost_usd', 0.02);
    const text = m.render();
    expect(text).toContain('# TYPE dvo_tasks_total counter');
    expect(text).toContain('dvo_tasks_total{outcome="succeeded",verification="verified"} 3');
    expect(text).toContain('dvo_attempts_active 3');
    expect(text).toContain('dvo_task_cost_usd_bucket{le="0.05"} 1');
    expect(text).toContain('dvo_task_cost_usd_bucket{le="+Inf"} 1');
    expect(text).toContain('dvo_task_cost_usd_count 1');
    expect(m.value('dvo_tasks_total', { outcome: 'succeeded', verification: 'verified' })).toBe(3);
  });

  it('drops unknown labels, escapes values and enforces metric types', () => {
    const m = new MetricsRegistry();
    m.inc('dvo_retries_total', { operation: 'a"b\n', bogus: 'x' });
    expect(m.render()).toContain('dvo_retries_total{operation="a\\"b\\n"} 1');
    expect(() => m.set('dvo_retries_total', 1)).toThrow(/is a counter/);
  });
});
