import {
  AttemptId,
  type Executor,
  type HarnessStore,
  PeerId,
  type PolicyEngine,
  type TaskSpec,
  type TaskState,
  type TrustTier,
} from '@dvo/core';
import { Redactor } from '@dvo/evidence';
import { type EngineConfig, OrchestrationEngine, ReliabilityTracker } from '@dvo/orchestrator';
import { DvoRulePolicy } from '@dvo/policy';
import { AttemptScheduler, CircuitRegistry } from '@dvo/scheduler';
import { InMemoryStore, MetricsRegistry } from '@dvo/trace';
import { ExactAnswerVerifier, VerifierRegistry } from '@dvo/verifier';
import { FakeClock, type Script, ScriptedExecutor, SequentialIds } from '@dvo/testkit';

export interface PeerSpec {
  id: string;
  script: Script[];
  trustTier?: TrustTier;
  allowRestricted?: boolean;
  costPerCallUsd?: number;
  /** Seeded history: [successes, failures] recorded before the test runs. */
  history?: [number, number];
  executor?: Executor;
}

export interface HarnessOptions {
  local?: Script[] | null;
  /** Seeded local history: [successes, failures]. */
  localHistory?: [number, number];
  localExecutor?: Executor;
  peers?: PeerSpec[];
  verifier?: boolean;
  policy?: PolicyEngine;
  store?: HarnessStore;
  clock?: FakeClock;
  ids?: SequentialIds;
  config?: Partial<EngineConfig>;
}

export const redactor = new Redactor();

export async function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
  const ids = options.ids ?? new SequentialIds();
  const store = options.store ?? new InMemoryStore({ sanitize: (v) => redactor.redact(v).value, clock });
  const local =
    options.localExecutor ??
    (options.local === null
      ? undefined
      : new ScriptedExecutor({ id: 'dsh-local', clock, script: options.local ?? [{ kind: 'answer', answer: '42', latencyMs: 1000 }] }));
  const peers = (options.peers ?? []).map((p) => ({
    spec: p,
    executor: p.executor ?? new ScriptedExecutor({ id: p.id, kind: 'a2a-peer', remote: true, clock, script: p.script }),
  }));
  for (const { spec } of peers) {
    const [successes, failures] = spec.history ?? [0, 0];
    for (let i = 0; i < successes + failures; i++) {
      await store.recordOutcome({
        attemptId: AttemptId(`seed-${spec.id}-${i}`),
        executorId: spec.id,
        skill: 'general',
        success: i < successes,
        terminalStatus: i < successes ? 'completed' : 'failed',
        latencyMs: 1000,
        costUsd: spec.costPerCallUsd ?? 0.01,
        artifactFailure: false,
        at: 'seed',
      });
    }
  }
  const [localOk, localBad] = options.localHistory ?? [0, 0];
  for (let i = 0; i < localOk + localBad; i++) {
    await store.recordOutcome({
      attemptId: AttemptId(`seed-local-${i}`),
      executorId: 'dsh-local',
      skill: 'general',
      success: i < localOk,
      terminalStatus: i < localOk ? 'completed' : 'failed',
      latencyMs: 1000,
      costUsd: 0.002,
      artifactFailure: false,
      at: 'seed',
    });
  }
  const verifiers = new VerifierRegistry(options.verifier === true ? [new ExactAnswerVerifier()] : [], () => clock.now());
  const circuits = new CircuitRegistry(clock);
  const reliability = new ReliabilityTracker(store);
  await reliability.refresh();
  const metrics = new MetricsRegistry();
  const scheduler = new AttemptScheduler({ clock, globalConcurrency: 8, executorConcurrency: () => 2, cancelGraceMs: 1000, metrics });
  const engine = new OrchestrationEngine({
    store,
    policy: options.policy ?? new DvoRulePolicy(),
    scheduler,
    catalog: {
      ...(local === undefined ? {} : { local: { executor: local, costEstimateUsd: 0.002, timeoutMs: 60_000, maxConcurrency: 1 } }),
      peers: peers.map(({ spec, executor }) => ({
        peerId: PeerId(spec.id),
        executor,
        trustTier: spec.trustTier ?? 'internal',
        allowRestricted: spec.allowRestricted ?? false,
        costPerCallUsd: spec.costPerCallUsd ?? 0.01,
        timeoutMs: 60_000,
        maxConcurrency: 2,
      })),
      verifiers,
    },
    circuits,
    reliability,
    redactor,
    clock,
    ids,
    metrics,
    ...(options.config === undefined ? {} : { config: options.config }),
  });

  const run = async (spec: TaskSpec, clientRequestKey?: string): Promise<TaskState> => {
    const { taskId } = await engine.submit(spec, clientRequestKey === undefined ? {} : { clientRequestKey });
    return clock.runUntilSettled(engine.waitForTerminal(taskId));
  };
  const peerExecutor = (id: string) => peers.find((p) => p.spec.id === id)!.executor as ScriptedExecutor;
  return {
    engine,
    clock,
    store,
    local: local as ScriptedExecutor | undefined,
    peerExecutor,
    metrics,
    run,
    circuits,
    reliability,
    scheduler,
  };
}

export const exact = (expected: string | number) => ({ verifierId: 'exact-answer', params: { expected } });
