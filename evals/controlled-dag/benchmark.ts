import { fromIso, PeerId, percentile, type PolicyEngine, type TaskState } from '@dvo/core';
import { Redactor } from '@dvo/evidence';
import { OrchestrationEngine, ReliabilityTracker } from '@dvo/orchestrator';
import { ConfidenceGatedPolicy, DvoRulePolicy, FixedTopologyPolicy, LocalOnlyPolicy, policyConfig } from '@dvo/policy';
import { AttemptScheduler, CircuitRegistry } from '@dvo/scheduler';
import { InMemoryStore } from '@dvo/trace';
import { ExactAnswerVerifier, VerifierRegistry } from '@dvo/verifier';
import { FakeClock, SequentialIds } from '@dvo/testkit';
import { DEFAULT_PROFILES, SimExecutor, type SimProfile } from './sim-executor.ts';
import { type DagTask, generateTasks } from './tasks.ts';

export type Scenario = 'calibrated-local' | 'overconfident-local';

export interface BenchmarkOptions {
  tasks: number;
  seed: number;
  /** `overconfident-local`: the local model always self-reports 0.95 (design §17 risk). */
  scenario?: Scenario;
  budget: { maxCostUsd: number; maxRemoteCalls: number; maxParallelAttempts: number; deadlineMs: number };
  profiles?: SimProfile[];
}

export interface TaskOutcome {
  tag: string;
  depth: number;
  success: boolean;
  status: string;
  verification: string;
  costUsd: number;
  latencyMs: number;
  remoteCalls: number;
  decisions: number;
}

export interface StrategySummary {
  strategy: string;
  policyVersion: string;
  n: number;
  successRate: number;
  successCi95: [number, number];
  meanCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanRemoteCalls: number;
  budgetViolations: number;
  pareto: boolean;
  byDepth: Record<string, number>;
}

export interface Strategy {
  name: string;
  make: () => PolicyEngine;
  /** Utility of a verified answer in USD-equivalent (the DVO value model weighs cost against it). */
  successValueUsd: number;
  /** Opt tasks into randomised exploration (design §7.2; the policy must enable it too). */
  explore?: boolean;
}

export const STRATEGIES: Strategy[] = [
  { name: 'single-agent (local only)', make: () => new LocalOnlyPolicy(), successValueUsd: 1 },
  { name: 'fixed topology (fan-out)', make: () => new FixedTopologyPolicy(), successValueUsd: 1 },
  { name: 'confidence-gated (τ=0.8)', make: () => new ConfidenceGatedPolicy(0.8), successValueUsd: 1 },
  { name: 'DVO (value $1 / success)', make: () => new DvoRulePolicy(), successValueUsd: 1 },
  { name: 'DVO (value $0.10 / success)', make: () => new DvoRulePolicy(), successValueUsd: 0.1 },
  {
    name: 'DVO + ε=0.1 exploration ($0.10)',
    make: () =>
      new DvoRulePolicy(policyConfig({ version: 'dvo-rules/1.0.0+explore', exploration: { enabled: true, epsilon: 0.1, seed: 1 } })),
    successValueUsd: 0.1,
    explore: true,
  },
];

export function profilesFor(scenario: Scenario = 'calibrated-local'): SimProfile[] {
  if (scenario === 'calibrated-local') return DEFAULT_PROFILES;
  return DEFAULT_PROFILES.map((p) => (p.kind === 'dsh-local' ? { ...p, confidence: 'overconfident' as const } : p));
}

/**
 * Runs every strategy on the same seeded task stream, compute-matched (identical hard
 * budgets), in virtual time. Each strategy starts with no history and learns executor
 * reliability online from its own verified outcomes, exactly as in production.
 */
export async function runBenchmark(
  options: BenchmarkOptions,
): Promise<{ summaries: StrategySummary[]; outcomes: Record<string, TaskOutcome[]> }> {
  const tasks = generateTasks(options.tasks, options.seed);
  const outcomes: Record<string, TaskOutcome[]> = {};
  const versions: Record<string, string> = {};
  for (const strategy of STRATEGIES) {
    const policy = strategy.make();
    versions[strategy.name] = policy.version;
    outcomes[strategy.name] = await runStrategy(policy, tasks, options, strategy.successValueUsd, strategy.explore === true);
  }
  const summaries = Object.entries(outcomes).map(([strategy, rows]) =>
    summarise(strategy, versions[strategy]!, rows, options.budget.maxCostUsd),
  );
  markPareto(summaries);
  return { summaries, outcomes };
}

async function runStrategy(
  policy: PolicyEngine,
  tasks: DagTask[],
  options: BenchmarkOptions,
  successValueUsd: number,
  explore: boolean,
): Promise<TaskOutcome[]> {
  const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
  const redactor = new Redactor();
  const store = new InMemoryStore({ clock });
  const byTag = new Map(tasks.map((t) => [t.tag, t]));
  const profiles = options.profiles ?? profilesFor(options.scenario);
  const executors = profiles.map((p) => new SimExecutor(p, clock, byTag, options.seed));
  const local = executors.find((e) => e.kind === 'dsh-local');
  const peers = executors.filter((e) => e.kind === 'a2a-peer');
  const reliability = new ReliabilityTracker(store);
  const engine = new OrchestrationEngine({
    store,
    policy,
    scheduler: new AttemptScheduler({ clock, globalConcurrency: 16, executorConcurrency: () => 4, cancelGraceMs: 1000 }),
    catalog: {
      ...(local === undefined
        ? {}
        : { local: { executor: local, costEstimateUsd: local.profile.costUsd, timeoutMs: 30_000, maxConcurrency: 4 } }),
      peers: peers.map((e) => ({
        peerId: PeerId(e.id),
        executor: e,
        trustTier: 'internal' as const,
        allowRestricted: false,
        costPerCallUsd: e.profile.costUsd,
        timeoutMs: 40_000,
        maxConcurrency: 4,
      })),
      verifiers: new VerifierRegistry([new ExactAnswerVerifier()], () => clock.now()),
    },
    circuits: new CircuitRegistry(clock),
    reliability,
    redactor,
    clock,
    ids: new SequentialIds(),
  });
  const rows: TaskOutcome[] = [];
  for (const task of tasks) {
    const { taskId } = await engine.submit({
      goal: task.goal,
      classification: 'public',
      successValueUsd,
      safeForExploration: explore,
      verification: { verifierId: 'exact-answer', params: { expected: task.answer } },
      budget: {
        maxCostUsd: options.budget.maxCostUsd,
        maxRemoteCalls: options.budget.maxRemoteCalls,
        maxParallelAttempts: options.budget.maxParallelAttempts,
        deadlineMs: options.budget.deadlineMs,
      },
      hints: { criticalPathLength: task.depth, independentSubtasks: task.independent },
    });
    const state = await clock.runUntilSettled(engine.waitForTerminal(taskId));
    rows.push(outcomeOf(task, state));
  }
  return rows;
}

function outcomeOf(task: DagTask, state: TaskState): TaskOutcome {
  const outcome = state.outcome!;
  return {
    tag: task.tag,
    depth: task.depth,
    success: outcome.status === 'succeeded' && outcome.verificationStatus === 'verified',
    status: outcome.status,
    verification: outcome.verificationStatus,
    costUsd: state.spent.costUsd,
    latencyMs: fromIso(outcome.finalizedAt) - fromIso(state.createdAt),
    remoteCalls: state.spent.remoteCalls,
    decisions: state.decisionCount,
  };
}

function summarise(strategy: string, policyVersion: string, rows: TaskOutcome[], maxCost: number): StrategySummary {
  const n = rows.length;
  const successes = rows.filter((r) => r.success).length;
  const byDepth: Record<string, number> = {};
  for (const depth of [...new Set(rows.map((r) => r.depth))].sort((a, b) => a - b)) {
    const group = rows.filter((r) => r.depth === depth);
    byDepth[String(depth)] = round(group.filter((r) => r.success).length / group.length, 3);
  }
  return {
    strategy,
    policyVersion,
    n,
    successRate: round(successes / n, 4),
    successCi95: wilson(successes, n),
    meanCostUsd: round(rows.reduce((s, r) => s + r.costUsd, 0) / n, 5),
    p50LatencyMs:
      percentile(
        rows.map((r) => r.latencyMs),
        0.5,
      ) ?? 0,
    p95LatencyMs:
      percentile(
        rows.map((r) => r.latencyMs),
        0.95,
      ) ?? 0,
    meanRemoteCalls: round(rows.reduce((s, r) => s + r.remoteCalls, 0) / n, 3),
    budgetViolations: rows.filter((r) => r.costUsd > maxCost + 1e-9).length,
    pareto: false,
    byDepth,
  };
}

/**
 * Success–cost–latency Pareto front (design §14 M4): a strategy is dominated if another one is
 * at least as good on success rate, mean cost and p95 latency, and strictly better on one.
 */
function markPareto(summaries: StrategySummary[]): void {
  const dominates = (o: StrategySummary, s: StrategySummary): boolean =>
    o.successRate >= s.successRate &&
    o.meanCostUsd <= s.meanCostUsd &&
    o.p95LatencyMs <= s.p95LatencyMs &&
    (o.successRate > s.successRate || o.meanCostUsd < s.meanCostUsd || o.p95LatencyMs < s.p95LatencyMs);
  for (const s of summaries) s.pareto = !summaries.some((o) => o !== s && dominates(o, s));
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denom = 1 + (z * z) / n;
  return [round((centre - margin) / denom, 4), round((centre + margin) / denom, 4)];
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function markdownReport(summaries: StrategySummary[], options: BenchmarkOptions): string {
  const header = `| Strategy | Success (95% CI) | Mean cost (USD) | p50 / p95 latency (s) | Remote calls | Pareto (success·cost·p95) |\n|---|---|---|---|---|---|`;
  const rows = summaries.map(
    (s) =>
      `| ${s.strategy} | ${(s.successRate * 100).toFixed(1)}% (${(s.successCi95[0] * 100).toFixed(1)}–${(s.successCi95[1] * 100).toFixed(1)}) | ${s.meanCostUsd.toFixed(4)} | ${(s.p50LatencyMs / 1000).toFixed(1)} / ${(s.p95LatencyMs / 1000).toFixed(1)} | ${s.meanRemoteCalls.toFixed(2)} | ${s.pareto ? '✓' : ''} |`,
  );
  const depths = Object.keys(summaries[0]?.byDepth ?? {});
  const depthHeader = `| Strategy | ${depths.map((d) => `depth ${d}`).join(' | ')} |\n|---|${depths.map(() => '---').join('|')}|`;
  const depthRows = summaries.map(
    (s) => `| ${s.strategy} | ${depths.map((d) => `${((s.byDepth[d] ?? 0) * 100).toFixed(0)}%`).join(' | ')} |`,
  );
  return [
    `### Controlled-DAG benchmark — ${options.scenario ?? 'calibrated-local'} (seed ${options.seed}, ${options.tasks} tasks, compute-matched)`,
    '',
    `Budget per task: $${options.budget.maxCostUsd}, ≤ ${options.budget.maxRemoteCalls} remote calls, ≤ ${options.budget.maxParallelAttempts} parallel attempts, ${options.budget.deadlineMs / 1000}s deadline. Success = final answer verified by the exact-answer verifier.`,
    '',
    header,
    ...rows,
    '',
    'Success rate by task depth:',
    '',
    depthHeader,
    ...depthRows,
    '',
  ].join('\n');
}
