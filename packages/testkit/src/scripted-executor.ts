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
  NOOP_OBSERVER,
  type NormalizedExecutionResult,
  type PreparedSubmission,
  type ResumeRef,
  type TerminalStatus,
} from '@dvo/core';

/** One scripted behaviour for a call to a ScriptedExecutor. */
export type Script =
  | {
      kind: 'answer';
      answer: string;
      confidence?: number;
      latencyMs?: number;
      costUsd?: number;
      tier?: 0 | 1 | 2;
      tokens?: { input: number; output: number };
    }
  | { kind: 'fail'; code?: string; retryable?: boolean; latencyMs?: number; status?: Exclude<TerminalStatus, 'completed'> }
  | { kind: 'hang' }
  | { kind: 'throw'; message?: string }
  | {
      kind: 'raw';
      result: (request: ExecutionRequest) => Omit<NormalizedExecutionResult, 'correlation' | 'executorId'>;
      latencyMs?: number;
    };

export interface ScriptedExecutorOptions {
  id: string;
  kind?: ExecutorKind;
  clock: Clock;
  /** Per-call scripts; the last one repeats. A function gets the call index. */
  script: Script[] | ((call: number, request: ExecutionRequest) => Script);
  capabilities?: Partial<ExecutorCapabilities>;
  /** Report `remote_submitted` progress like an A2A peer would. */
  remote?: boolean;
}

/**
 * Deterministic Executor double: answers, fails, hangs or throws per script, sleeping on the
 * injected clock so tests control time exactly. Records every request it receives.
 */
export class ScriptedExecutor implements Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly requests: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  readonly #options: ScriptedExecutorOptions;
  #calls = 0;

  constructor(options: ScriptedExecutorOptions) {
    this.id = options.id;
    this.kind = options.kind ?? 'dsh-local';
    this.#options = options;
  }

  get calls(): number {
    return this.#calls;
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    return {
      kind: this.kind,
      skills: ['general'],
      maxEvidenceTier: 2,
      supportsCancel: true,
      supportsResume: this.kind === 'a2a-peer',
      supportsIdempotentResubmit: false,
      available: true,
      ...this.#options.capabilities,
    };
  }

  async prepare(request: ExecutionRequest): Promise<PreparedSubmission> {
    return { payload: { prompt: request.prompt }, requestDigest: `digest:${request.correlation.idempotencyKey}` };
  }

  async resume(ref: ResumeRef, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    return this.start(ref.request, observer);
  }

  async start(request: ExecutionRequest, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    const call = this.#calls++;
    this.requests.push(request);
    const scripts = this.#options.script;
    const script =
      typeof scripts === 'function' ? scripts(call, request) : (scripts[Math.min(call, scripts.length - 1)] ?? { kind: 'hang' });
    if (script.kind === 'throw') throw new Error(script.message ?? 'scripted start failure');
    const attemptId = request.correlation.attemptId ?? ('att_scripted' as AttemptId);
    const clock = this.#options.clock;
    const started = clock.now();
    let resolveCancel: ((reason: string) => void) | undefined;
    const cancelled = new Promise<string>((resolve) => (resolveCancel = resolve));
    if (this.#options.remote === true) {
      observer.onProgress({
        kind: 'remote_submitted',
        remoteTaskId: `remote-${attemptId}`,
        requestDigest: `digest:${request.correlation.idempotencyKey}`,
      });
    }

    const base = { correlation: request.correlation, executorId: this.id };
    const finish = (): Promise<NormalizedExecutionResult> => {
      switch (script.kind) {
        case 'hang':
          return cancelled.then((reason) => ({
            ...base,
            terminalStatus: 'cancelled',
            usage: { elapsedMs: clock.now() - started },
            diagnostics: [diagnostic('cancelled', reason)],
          }));
        case 'answer':
        case 'fail':
        case 'raw': {
          const latency = script.latencyMs ?? 0;
          const done = new Promise<'done'>((resolve) => clock.setTimer(latency, () => resolve('done')));
          return Promise.race([done, cancelled]).then((winner): NormalizedExecutionResult => {
            const elapsedMs = clock.now() - started;
            if (winner !== 'done') {
              return { ...base, terminalStatus: 'cancelled', usage: { elapsedMs }, diagnostics: [diagnostic('cancelled', winner)] };
            }
            if (script.kind === 'raw') return { ...base, ...script.result(request) };
            if (script.kind === 'fail') {
              return {
                ...base,
                terminalStatus: script.status ?? 'failed',
                usage: { elapsedMs, costUsd: 0 },
                diagnostics: [diagnostic(script.code ?? 'scripted_failure', 'scripted failure', script.retryable ?? false)],
              };
            }
            return {
              ...base,
              terminalStatus: 'completed',
              output: {
                schemaVersion: EVIDENCE_SCHEMA_VERSION,
                correlation: request.correlation,
                tier: script.tier ?? 1,
                taskScope: 'scripted',
                claims: [
                  {
                    id: 'answer',
                    statement: script.answer,
                    confidence: script.confidence ?? 0.8,
                    assumptions: [],
                    dependencies: [],
                    status: 'proposed',
                  },
                ],
                evidence: [],
                redactionApplied: false,
              },
              usage: {
                elapsedMs,
                costUsd: script.costUsd ?? 0.001,
                inputTokens: script.tokens?.input ?? 100,
                outputTokens: script.tokens?.output ?? 50,
              },
              diagnostics: [],
            };
          });
        }
      }
    };
    const result = finish();
    return {
      attemptId,
      cancel: async (reason = 'cancelled') => {
        this.cancelled.push(attemptId);
        resolveCancel?.(reason);
      },
      result: () => result,
    };
  }
}
