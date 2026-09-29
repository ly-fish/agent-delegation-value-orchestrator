import { type Labels, type MetricDefinition, type MetricName, METRICS, type MetricsSink } from '@dvo/core';

interface HistogramSeries {
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * In-process metrics registry for the catalog in `@dvo/core`, rendering the Prometheus
 * text exposition format (0.0.4). Unknown label names are dropped so a caller mistake
 * cannot explode series cardinality.
 */
export class MetricsRegistry implements MetricsSink {
  readonly #values = new Map<MetricName, Map<string, number>>();
  readonly #histograms = new Map<MetricName, Map<string, HistogramSeries>>();

  inc(name: MetricName, labels: Labels = {}, value = 1): void {
    const def = this.#def(name, 'counter');
    if (value < 0) return;
    const series = this.#series(this.#values, name);
    const key = labelKey(def, labels);
    series.set(key, (series.get(key) ?? 0) + value);
  }

  set(name: MetricName, value: number, labels: Labels = {}): void {
    const def = this.#def(name, 'gauge');
    this.#series(this.#values, name).set(labelKey(def, labels), value);
  }

  observe(name: MetricName, value: number, labels: Labels = {}): void {
    const def = this.#def(name, 'histogram');
    const bounds = def.buckets ?? [];
    const series = this.#series(this.#histograms, name);
    const key = labelKey(def, labels);
    const h = series.get(key) ?? { buckets: new Array<number>(bounds.length).fill(0), sum: 0, count: 0 };
    bounds.forEach((bound, i) => {
      if (value <= bound) h.buckets[i]! += 1;
    });
    h.sum += value;
    h.count += 1;
    series.set(key, h);
  }

  /** Current value of a counter/gauge series (tests, health endpoints). */
  value(name: MetricName, labels: Labels = {}): number {
    return this.#values.get(name)?.get(labelKey(METRICS[name], labels)) ?? 0;
  }

  histogram(name: MetricName, labels: Labels = {}): { sum: number; count: number } | undefined {
    const h = this.#histograms.get(name)?.get(labelKey(METRICS[name], labels));
    return h === undefined ? undefined : { sum: h.sum, count: h.count };
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, def] of Object.entries(METRICS) as Array<[MetricName, MetricDefinition]>) {
      lines.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} ${def.type}`);
      if (def.type === 'histogram') {
        for (const [key, h] of this.#histograms.get(name) ?? []) {
          const bounds = def.buckets ?? [];
          bounds.forEach((bound, i) => lines.push(`${name}_bucket${withLabel(key, 'le', String(bound))} ${h.buckets[i]}`));
          lines.push(
            `${name}_bucket${withLabel(key, 'le', '+Inf')} ${h.count}`,
            `${name}_sum${braces(key)} ${h.sum}`,
            `${name}_count${braces(key)} ${h.count}`,
          );
        }
      } else {
        for (const [key, value] of this.#values.get(name) ?? []) lines.push(`${name}${braces(key)} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  #def(name: MetricName, type: MetricDefinition['type']): MetricDefinition {
    const def: MetricDefinition = METRICS[name];
    if (def.type !== type) throw new TypeError(`metric ${name} is a ${def.type}, not a ${type}`);
    return def;
  }

  #series<T>(store: Map<MetricName, Map<string, T>>, name: MetricName): Map<string, T> {
    let series = store.get(name);
    if (series === undefined) {
      series = new Map();
      store.set(name, series);
    }
    return series;
  }
}

function labelKey(def: MetricDefinition, labels: Labels): string {
  return def.labels
    .filter((l) => labels[l] !== undefined)
    .map((l) => `${l}="${escape(labels[l]!)}"`)
    .join(',');
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function braces(key: string): string {
  return key === '' ? '' : `{${key}}`;
}

function withLabel(key: string, label: string, value: string): string {
  return `{${key === '' ? '' : `${key},`}${label}="${value}"}`;
}
