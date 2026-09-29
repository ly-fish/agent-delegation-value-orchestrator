// npm run eval:dag -- --tasks 300 --seed 7
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { markdownReport, runBenchmark, type Scenario } from './benchmark.ts';

const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: '200' },
    seed: { type: 'string', default: '7' },
    out: { type: 'string', default: 'evals/results' },
    scenario: { type: 'string', default: 'calibrated-local' },
  },
});

const options = {
  tasks: Number(values.tasks),
  seed: Number(values.seed),
  scenario: values.scenario as Scenario,
  budget: { maxCostUsd: 0.06, maxRemoteCalls: 3, maxParallelAttempts: 3, deadlineMs: 90_000 },
};
const started = Date.now();
const { summaries, outcomes } = await runBenchmark(options);
const report = markdownReport(summaries, options);
await mkdir(values.out, { recursive: true });
const base = join(values.out, `controlled-dag-${options.scenario}-seed${options.seed}-n${options.tasks}`);
await writeFile(`${base}.json`, JSON.stringify({ options, summaries, outcomes }, null, 2));
await writeFile(`${base}.md`, report);
process.stdout.write(`${report}\n(wrote ${base}.json and .md in ${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
