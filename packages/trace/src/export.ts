import {
  describeAction,
  type DomainEvent,
  fromIso,
  type OrchestrationAction,
  projectTask,
  type TaskId,
  type TaskRepository,
} from '@dvo/core';

/** One row per decision: the unit of analysis for delegation-value research (design §7.2, §11.3.5). */
export interface DecisionRow {
  taskId: TaskId;
  decisionIndex: number;
  policyVersion: string;
  features: Record<string, number>;
  candidates: Array<{ action: string; netValue: number; lowerConfidenceBound: number; estimatedCostUsd: number; blockedBy: string[] }>;
  selected: string;
  selectedKind: OrchestrationAction['kind'];
  propensity: number;
  explored: boolean;
  outcome: {
    status: string;
    verification: string;
    success: 0 | 1;
    costUsd: number;
    latencyMs: number;
    remoteCalls: number;
  };
}

/**
 * Converts a task's log into decision rows labelled with the task outcome. `success` is 1
 * only for tasks that succeeded with a *verified* answer, so LLM-judged or self-reported
 * success can never leak into the reward signal.
 */
export function decisionRows(events: readonly DomainEvent[]): DecisionRow[] {
  const state = projectTask(events);
  if (state === undefined) return [];
  const created = fromIso(state.createdAt);
  const finalized = state.outcome === undefined ? undefined : fromIso(state.outcome.finalizedAt);
  const outcome: DecisionRow['outcome'] = {
    status: state.outcome?.status ?? state.phase,
    verification: state.outcome?.verificationStatus ?? 'unverified',
    success: state.outcome?.status === 'succeeded' && state.outcome.verificationStatus === 'verified' ? 1 : 0,
    costUsd: state.spent.costUsd,
    latencyMs: finalized === undefined ? 0 : finalized - created,
    remoteCalls: state.spent.remoteCalls,
  };
  return events.flatMap((event) => {
    if (event.type !== 'decision.made') return [];
    const { record } = event.payload;
    return [
      {
        taskId: event.taskId,
        decisionIndex: record.decisionIndex,
        policyVersion: record.policyVersion,
        features: record.features,
        candidates: record.candidateActions.map((c) => ({
          action: describeAction(c.action),
          netValue: c.netValue,
          lowerConfidenceBound: c.lowerConfidenceBound,
          estimatedCostUsd: c.estimatedCostUsd,
          blockedBy: c.blockedBy ?? [],
        })),
        selected: describeAction(record.selected),
        selectedKind: record.selected.kind,
        propensity: record.propensity,
        explored: record.explored,
        outcome,
      },
    ];
  });
}

/** Streams redacted events (or decision rows) of the given tasks as JSON Lines. */
export async function* exportJsonl(
  store: TaskRepository,
  options: { taskIds?: readonly TaskId[]; kind?: 'events' | 'decisions' } = {},
): AsyncGenerator<string> {
  const ids = options.taskIds ?? (await store.listTasks()).map((t) => t.taskId);
  for (const taskId of ids) {
    const events = await store.events(taskId);
    if (options.kind === 'decisions') {
      for (const row of decisionRows(events)) yield `${JSON.stringify(row)}\n`;
    } else {
      for (const event of events) yield `${JSON.stringify(event)}\n`;
    }
  }
}
