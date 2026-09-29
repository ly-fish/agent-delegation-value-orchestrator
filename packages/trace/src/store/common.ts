import {
  type DecisionRecord,
  type DomainEvent,
  emptyHistogram,
  type ExecutorOutcome,
  type ExecutorStats,
  HarnessError,
  observeLatency,
  type TaskCommit,
} from '@dvo/core';

/** Applied to everything a store persists: the last line of defence against leaked secrets. */
export type Sanitizer = (value: unknown) => unknown;

export const identitySanitizer: Sanitizer = (value) => value;

export function validateCommit(commit: TaskCommit): void {
  if (commit.events.length === 0) throw new HarnessError('validation_failed', 'commit without events');
  if (commit.state.taskId !== commit.taskId) throw new HarnessError('validation_failed', 'commit state belongs to another task');
  if (commit.state.revision !== commit.expectedRevision + commit.events.length) {
    throw new HarnessError('validation_failed', 'commit state revision does not match its events', {
      details: { expected: commit.expectedRevision + commit.events.length, actual: commit.state.revision },
    });
  }
  for (const event of commit.events) {
    if (event.taskId !== commit.taskId) throw new HarnessError('validation_failed', 'commit contains an event of another task');
  }
  if (commit.expectedRevision === 0 && commit.events[0]?.type !== 'task.created') {
    throw new HarnessError('validation_failed', 'a new task must start with task.created');
  }
}

export function decisionsOf(events: readonly DomainEvent[]): DecisionRecord[] {
  return events.flatMap((event) => (event.type === 'decision.made' ? [event.payload.record] : []));
}

export function statsKey(executorId: string, skill: string): string {
  return `${executorId}\u0000${skill}`;
}

export function emptyStats(executorId: string, skill: string): ExecutorStats {
  return {
    executorId,
    skill,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    cancelCount: 0,
    artifactFailureCount: 0,
    totalCostUsd: 0,
    latency: emptyHistogram(),
  };
}

export function applyOutcome(stats: ExecutorStats, outcome: ExecutorOutcome): ExecutorStats {
  return {
    ...stats,
    successCount: stats.successCount + (outcome.success ? 1 : 0),
    failureCount: stats.failureCount + (outcome.success ? 0 : 1),
    timeoutCount: stats.timeoutCount + (outcome.terminalStatus === 'timed_out' ? 1 : 0),
    cancelCount: stats.cancelCount + (outcome.terminalStatus === 'cancelled' ? 1 : 0),
    artifactFailureCount: stats.artifactFailureCount + (outcome.artifactFailure ? 1 : 0),
    totalCostUsd: Math.round((stats.totalCostUsd + outcome.costUsd) * 1e6) / 1e6,
    latency: observeLatency(stats.latency, outcome.latencyMs),
  };
}
