import {
  type AttemptId,
  canonicalJson,
  describeAction,
  diagnostic,
  type DomainEvent,
  type ExecutionHandle,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorKind,
  type NormalizedExecutionResult,
  type PolicyEngine,
  projectTask,
  type TaskId,
  type TaskRepository,
  type TaskState,
} from '@dvo/core';

export interface DecisionReplay {
  decisionIndex: number;
  recordedPolicy: string;
  recorded: string;
  replayed?: string;
  replayPolicy?: string;
  matches?: boolean;
  recordedReason: string;
}

export interface ReplayReport {
  taskId: TaskId;
  eventCount: number;
  /** The fold of the event log equals the stored projection. */
  projectionMatches: boolean;
  rebuiltPhase: TaskState['phase'] | undefined;
  decisions: DecisionReplay[];
  /** Every re-run decision matched (vacuously true when no policy was supplied). */
  deterministic: boolean;
  /** Candidates evaluated but not executed, with why (design §11.3.4). */
  notExecuted: Array<{ decisionIndex: number; action: string; netValue: number; blockedBy: string[] }>;
}

/**
 * Rebuilds a task from its log and optionally re-runs every recorded decision against a
 * policy using the exact input it originally saw (design §11.3.1–2, 4). With the same policy
 * version this is a determinism check; with a new version it is a what-if comparison.
 */
export async function replayTask(store: TaskRepository, taskId: TaskId, policy?: PolicyEngine): Promise<ReplayReport> {
  const events = await store.events(taskId);
  const stored = await store.load(taskId);
  const rebuilt = projectTask(events);
  const projectionMatches = stored !== undefined && rebuilt !== undefined && canonicalJson(stored) === canonicalJson(rebuilt);

  const decisions: DecisionReplay[] = [];
  const notExecuted: ReplayReport['notExecuted'] = [];
  for (const event of events) {
    if (event.type !== 'decision.made') continue;
    const { record, input } = event.payload;
    const entry: DecisionReplay = {
      decisionIndex: record.decisionIndex,
      recordedPolicy: record.policyVersion,
      recorded: describeAction(record.selected),
      recordedReason: record.decisionReason,
    };
    if (policy !== undefined) {
      const replayed = policy.decide(input);
      entry.replayed = describeAction(replayed.selected);
      entry.replayPolicy = policy.version;
      entry.matches = canonicalJson(replayed.selected) === canonicalJson(record.selected);
    }
    decisions.push(entry);
    const selectedKey = canonicalJson(record.selected);
    for (const c of record.candidateActions) {
      if (canonicalJson(c.action) === selectedKey) continue;
      notExecuted.push({
        decisionIndex: record.decisionIndex,
        action: describeAction(c.action),
        netValue: c.netValue,
        blockedBy: c.blockedBy ?? [],
      });
    }
  }
  return {
    taskId,
    eventCount: events.length,
    projectionMatches,
    rebuiltPhase: rebuilt?.phase,
    decisions,
    deterministic: decisions.every((d) => d.matches !== false),
    notExecuted,
  };
}

/**
 * An executor that replays the results recorded in a trace instead of calling DSH or A2A
 * (design §11.3.3). Results are served per executor in recorded order; a request the trace
 * never observed yields a failed result tagged `unobserved_counterfactual`, so a what-if
 * run under a different policy shows exactly where it left the recorded data.
 */
export class RecordedExecutor implements Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly #results: NormalizedExecutionResult[];
  readonly #capabilities: ExecutorCapabilities;
  #cursor = 0;
  unobserved = 0;

  constructor(id: string, kind: ExecutorKind, results: NormalizedExecutionResult[], capabilities?: Partial<ExecutorCapabilities>) {
    this.id = id;
    this.kind = kind;
    this.#results = results;
    this.#capabilities = {
      kind,
      skills: [],
      maxEvidenceTier: 2,
      supportsCancel: true,
      supportsResume: false,
      supportsIdempotentResubmit: false,
      available: true,
      ...capabilities,
    };
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    return this.#capabilities;
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const recorded = this.#results[this.#cursor];
    this.#cursor += 1;
    let result: NormalizedExecutionResult;
    if (recorded === undefined) {
      this.unobserved += 1;
      result = {
        correlation: request.correlation,
        executorId: this.id,
        terminalStatus: 'failed',
        usage: { elapsedMs: 0 },
        diagnostics: [diagnostic('unobserved_counterfactual', 'no recorded result for this request')],
      };
    } else {
      result = {
        ...recorded,
        correlation: request.correlation,
        ...(recorded.output === undefined ? {} : { output: { ...recorded.output, correlation: request.correlation } }),
      };
    }
    return {
      attemptId: request.correlation.attemptId ?? ('att_replay' as AttemptId),
      cancel: async () => undefined,
      result: async () => result,
    };
  }
}

/** Groups the results recorded in a trace by executor, in the order they were produced. */
export function recordedResultsByExecutor(
  events: readonly DomainEvent[],
): Map<string, { kind: ExecutorKind; results: NormalizedExecutionResult[] }> {
  const executors = new Map<AttemptId, { executorId: string; kind: ExecutorKind }>();
  const out = new Map<string, { kind: ExecutorKind; results: NormalizedExecutionResult[] }>();
  for (const event of events) {
    if (event.type === 'attempt.created' && event.attemptId !== undefined) {
      executors.set(event.attemptId, { executorId: event.payload.executorId, kind: event.payload.executorKind });
    }
    if (event.type === 'attempt.result_recorded' && event.attemptId !== undefined) {
      const owner = executors.get(event.attemptId);
      if (owner === undefined) continue;
      const { result } = event.payload;
      const bucket = out.get(owner.executorId) ?? { kind: owner.kind, results: [] };
      bucket.results.push({
        correlation: {
          taskId: event.taskId,
          traceId: event.traceId,
          eventId: event.eventId,
          idempotencyKey: 'replay',
          occurredAt: event.occurredAt,
        },
        executorId: owner.executorId,
        terminalStatus: result.terminalStatus,
        ...(result.output === undefined ? {} : { output: result.output }),
        usage: result.usage,
        diagnostics: result.diagnostics,
      });
      out.set(owner.executorId, bucket);
    }
  }
  return out;
}
