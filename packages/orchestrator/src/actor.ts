import type { AttemptId, Logger, TaskState, TimerHandle } from '@dvo/core';
import type { ManagedAttempt } from '@dvo/scheduler';
import type { FinalizeReason } from './finalizer.ts';

/**
 * Per-task mailbox. Every mutation of a task — decisions, results, progress, cancels,
 * deadlines — runs as one job on this queue, so task state has a single writer in-process
 * and the store's CAS on revision only ever trips on a genuine cross-process conflict.
 */
export class TaskActor {
  state: TaskState;
  readonly running = new Map<AttemptId, ManagedAttempt>();
  readonly failedVerifiers = new Set<string>();
  pendingStop: { reason: FinalizeReason; detail: string } | undefined;
  deadlineTimer: TimerHandle | undefined;
  #queue: Promise<void> = Promise.resolve();
  readonly #logger: Logger;
  readonly #onError: (error: unknown) => void;

  constructor(state: TaskState, logger: Logger, onError: (error: unknown) => void) {
    this.state = state;
    this.#logger = logger;
    this.#onError = onError;
  }

  enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(job).catch((error: unknown) => {
      this.#logger.error(
        { taskId: this.state.taskId, error: error instanceof Error ? error.message : String(error) },
        'task actor job failed',
      );
      this.#onError(error);
    });
    this.#queue = next;
    return next;
  }

  /** Resolves once every job queued so far has run. */
  idle(): Promise<void> {
    return this.#queue;
  }

  dispose(): void {
    this.deadlineTimer?.cancel();
    this.deadlineTimer = undefined;
  }
}
