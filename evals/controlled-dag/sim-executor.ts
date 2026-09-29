import {
  type AttemptId,
  type Clock,
  diagnostic,
  EVIDENCE_SCHEMA_VERSION,
  type ExecutionHandle,
  type ExecutionObserver,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorKind,
  mulberry32,
  NOOP_OBSERVER,
  type NormalizedExecutionResult,
  type PreparedSubmission,
  seedFrom,
} from '@dvo/core';
import type { DagTask } from './tasks.ts';

/**
 * A simulated executor with a known competence profile. P(correct) = base · decay^depth.
 * Self-reported confidence is either calibrated (≈ the true probability) or always high —
 * the "trusting self-reports routes badly" failure mode of design §17.
 */
export interface SimProfile {
  id: string;
  kind: ExecutorKind;
  base: number;
  decay: number;
  costUsd: number;
  latencyMs: number;
  /** Probability of an infrastructure failure (timeout-like) per call. */
  failureRate: number;
  confidence: 'calibrated' | 'overconfident';
}

export class SimExecutor implements Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly profile: SimProfile;
  readonly #clock: Clock;
  readonly #tasks: Map<string, DagTask>;
  readonly #seed: number;
  #calls = 0;

  constructor(profile: SimProfile, clock: Clock, tasks: Map<string, DagTask>, seed: number) {
    this.id = profile.id;
    this.kind = profile.kind;
    this.profile = profile;
    this.#clock = clock;
    this.#tasks = tasks;
    this.#seed = seed;
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    return {
      kind: this.kind,
      skills: ['general'],
      maxEvidenceTier: 2,
      supportsCancel: true,
      supportsResume: false,
      supportsIdempotentResubmit: false,
      available: true,
    };
  }

  async prepare(request: ExecutionRequest): Promise<PreparedSubmission> {
    return { payload: { sim: true }, requestDigest: `sim:${request.correlation.idempotencyKey}` };
  }

  async start(request: ExecutionRequest, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    const call = this.#calls++;
    const tag = /\[(dag-[\d-]+)\]/.exec(request.prompt)?.[1];
    const task = tag === undefined ? undefined : this.#tasks.get(tag);
    const random = mulberry32(seedFrom(`${this.#seed}:${this.id}:${tag ?? 'none'}:${call}`));
    const latency = Math.round(this.profile.latencyMs * (0.6 + 0.8 * random()));
    const started = this.#clock.now();
    if (this.kind === 'a2a-peer') observer.onProgress({ kind: 'remote_submitted', remoteTaskId: `sim-${call}`, requestDigest: 'sim' });

    let cancel: (() => void) | undefined;
    const result = new Promise<NormalizedExecutionResult>((resolve) => {
      const base = { correlation: request.correlation, executorId: this.id };
      const timer = this.#clock.setTimer(latency, () => {
        const elapsedMs = this.#clock.now() - started;
        if (task === undefined || random() < this.profile.failureRate) {
          resolve({
            ...base,
            terminalStatus: 'timed_out',
            usage: { elapsedMs, costUsd: this.profile.costUsd },
            diagnostics: [diagnostic('sim_timeout', 'simulated infrastructure failure', true)],
          });
          return;
        }
        const pCorrect = this.profile.base * this.profile.decay ** task.depth;
        const correct = random() < pCorrect;
        const offset = 1 + Math.floor(random() * 9);
        const statement = String(correct ? task.answer : task.answer + (random() < 0.5 ? offset : -offset));
        const confidence =
          this.profile.confidence === 'overconfident' ? 0.95 : Math.min(0.99, Math.max(0.01, pCorrect + (random() - 0.5) * 0.1));
        resolve({
          ...base,
          terminalStatus: 'completed',
          output: {
            schemaVersion: EVIDENCE_SCHEMA_VERSION,
            correlation: request.correlation,
            tier: 1,
            taskScope: task.tag,
            claims: [{ id: 'answer', statement, confidence, assumptions: [], dependencies: [], status: 'proposed' }],
            evidence: [{ kind: 'observation', summary: `${this.id} computed the DAG` }],
            redactionApplied: false,
          },
          usage: { elapsedMs, costUsd: this.profile.costUsd, inputTokens: 500, outputTokens: 100 },
          diagnostics: [],
        });
      });
      cancel = () => {
        timer.cancel();
        resolve({
          ...base,
          terminalStatus: 'cancelled',
          usage: { elapsedMs: this.#clock.now() - started, costUsd: this.profile.costUsd },
          diagnostics: [diagnostic('cancelled', 'cancelled')],
        });
      };
    });
    return { attemptId: request.correlation.attemptId ?? ('att_sim' as AttemptId), cancel: async () => cancel?.(), result: () => result };
  }
}

export const DEFAULT_PROFILES: SimProfile[] = [
  {
    id: 'dsh-local',
    kind: 'dsh-local',
    base: 0.92,
    decay: 0.8,
    costUsd: 0.002,
    latencyMs: 3_000,
    failureRate: 0.02,
    confidence: 'calibrated',
  },
  {
    id: 'peer-specialist',
    kind: 'a2a-peer',
    base: 0.98,
    decay: 0.97,
    costUsd: 0.02,
    latencyMs: 8_000,
    failureRate: 0.03,
    confidence: 'calibrated',
  },
  {
    id: 'peer-overconfident',
    kind: 'a2a-peer',
    base: 0.7,
    decay: 0.85,
    costUsd: 0.004,
    latencyMs: 2_000,
    failureRate: 0.02,
    confidence: 'overconfident',
  },
  {
    id: 'peer-slow',
    kind: 'a2a-peer',
    base: 0.95,
    decay: 0.94,
    costUsd: 0.01,
    latencyMs: 25_000,
    failureRate: 0.1,
    confidence: 'calibrated',
  },
];
