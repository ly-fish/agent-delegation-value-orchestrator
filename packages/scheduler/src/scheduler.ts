import {
  type AttemptId,
  CancelledError,
  type Clock,
  DeadlineReached,
  deadlineSignal,
  diagnostic,
  type ExecutionHandle,
  type ExecutionObserver,
  type ExecutionRequest,
  type Executor,
  type Logger,
  type MetricsSink,
  NOOP_OBSERVER,
  noopLogger,
  noopMetrics,
  type NormalizedExecutionResult,
  type ResumeRef,
  sleep,
  type TaskId,
  type TerminalStatus,
  toDiagnostic,
} from '@dvo/core';
import type { CircuitBreaker } from './circuit-breaker.ts';
import { KeyedSemaphore, type Release, Semaphore } from './semaphore.ts';

export interface SchedulerOptions {
  clock: Clock;
  /** Attempts in flight across all tasks. */
  globalConcurrency: number;
  /** Attempts in flight per executor (per peer / per local runtime). */
  executorConcurrency: (executorId: string) => number;
  /** How long to wait for an executor to acknowledge a cancel before synthesising the result. */
  cancelGraceMs?: number;
  metrics?: MetricsSink;
  logger?: Logger;
}

export interface LaunchSpec {
  taskId: TaskId;
  attemptId: AttemptId;
  executor: Executor;
  request: ExecutionRequest;
  /** Absolute deadline (epoch ms) for this attempt, including time spent queued. */
  deadlineMs: number;
  observer?: ExecutionObserver;
  breaker?: CircuitBreaker;
  /** Re-attach to an attempt that was in flight before a restart instead of starting it. */
  resume?: ResumeRef;
  /** Called once permits are held, immediately before the executor is invoked. */
  onStart?: () => void;
}

export interface ManagedAttempt {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  /** Settles exactly once and never rejects. */
  readonly result: Promise<NormalizedExecutionResult>;
  cancel(reason?: string): void;
}

/**
 * Runs attempts under concurrency limits and deadlines (design §4.1 `scheduler`).
 * It never interprets outputs; it only guarantees that every launched attempt settles with
 * a normalised result, that deadlines turn into cancellation, and that permits are released.
 */
export class AttemptScheduler {
  readonly #clock: Clock;
  readonly #global: Semaphore;
  readonly #perExecutor: KeyedSemaphore;
  readonly #graceMs: number;
  readonly #metrics: MetricsSink;
  readonly #logger: Logger;
  readonly #active = new Map<AttemptId, ManagedAttempt>();

  constructor(options: SchedulerOptions) {
    this.#clock = options.clock;
    this.#global = new Semaphore(options.globalConcurrency);
    this.#perExecutor = new KeyedSemaphore(options.executorConcurrency);
    this.#graceMs = options.cancelGraceMs ?? 5_000;
    this.#metrics = options.metrics ?? noopMetrics;
    this.#logger = options.logger ?? noopLogger;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  activeFor(taskId: TaskId): ManagedAttempt[] {
    return [...this.#active.values()].filter((a) => a.taskId === taskId);
  }

  launch(spec: LaunchSpec): ManagedAttempt {
    const existing = this.#active.get(spec.attemptId);
    if (existing !== undefined) return existing; // idempotent: one live run per attempt id

    const cancelController = new AbortController();
    let cancelReason = 'cancelled';
    const startedAt = this.#clock.now();
    const synth = (status: TerminalStatus, code: string, message: string, retryable = false): NormalizedExecutionResult => ({
      correlation: spec.request.correlation,
      executorId: spec.executor.id,
      terminalStatus: status,
      usage: { elapsedMs: this.#clock.now() - startedAt },
      diagnostics: [diagnostic(code, message, retryable)],
    });

    const run = async (): Promise<NormalizedExecutionResult> => {
      const deadline = deadlineSignal(this.#clock, spec.deadlineMs, cancelController.signal);
      const releases: Release[] = [];
      let breakerHeld = false;
      try {
        try {
          this.#reportQueue();
          releases.push(await this.#global.acquire(deadline.signal));
          releases.push(await this.#perExecutor.acquire(spec.executor.id, deadline.signal));
        } catch {
          return cancelController.signal.aborted
            ? synth('cancelled', 'cancelled_before_start', 'cancelled while queued')
            : synth('timed_out', 'queue_timeout', 'deadline reached while queued', true);
        } finally {
          this.#reportQueue();
        }

        if (spec.breaker !== undefined) {
          if (!spec.breaker.tryAcquire()) return synth('failed', 'circuit_open', 'executor circuit is open');
          breakerHeld = true;
        }

        let handle: ExecutionHandle;
        try {
          spec.onStart?.();
          const observer = spec.observer ?? NOOP_OBSERVER;
          handle =
            spec.resume !== undefined && spec.executor.resume !== undefined
              ? await spec.executor.resume(spec.resume, observer)
              : await spec.executor.start(spec.request, observer);
        } catch (error) {
          const d = toDiagnostic(error, 'executor_start_failed');
          const result = synth('failed', d.code, d.safeMessage, d.retryable);
          if (breakerHeld) this.#updateBreaker(spec.breaker!, result);
          breakerHeld = false;
          return result;
        }

        const result = await this.#settle(handle, deadline.signal, cancelController.signal, () => cancelReason, synth);
        if (breakerHeld) this.#updateBreaker(spec.breaker!, result);
        breakerHeld = false;
        return result;
      } catch (error) {
        // Defensive: the contract says nothing above throws, but a bug must not orphan an attempt.
        this.#logger.error({ attemptId: spec.attemptId, error: toDiagnostic(error) }, 'scheduler invariant violated');
        if (breakerHeld) spec.breaker!.onNeutral();
        return synth('failed', 'scheduler_error', 'internal scheduler error', true);
      } finally {
        deadline.dispose();
        for (const release of releases.reverse()) release();
      }
    };

    const result = run().finally(() => {
      this.#active.delete(spec.attemptId);
      this.#metrics.set('dvo_attempts_active', this.#active.size);
    });
    const managed: ManagedAttempt = {
      attemptId: spec.attemptId,
      taskId: spec.taskId,
      result,
      cancel: (reason = 'cancelled') => {
        cancelReason = reason;
        if (!cancelController.signal.aborted) cancelController.abort(new CancelledError(reason));
      },
    };
    this.#active.set(spec.attemptId, managed);
    this.#metrics.set('dvo_attempts_active', this.#active.size);
    return managed;
  }

  cancelTask(taskId: TaskId, reason: string): number {
    const attempts = this.activeFor(taskId);
    for (const attempt of attempts) attempt.cancel(reason);
    return attempts.length;
  }

  /** Waits for every in-flight attempt to settle (used on shutdown after cancelling). */
  async drain(): Promise<void> {
    await Promise.all([...this.#active.values()].map((a) => a.result));
  }

  async #settle(
    handle: ExecutionHandle,
    stop: AbortSignal,
    cancelled: AbortSignal,
    reason: () => string,
    synth: (status: TerminalStatus, code: string, message: string, retryable?: boolean) => NormalizedExecutionResult,
  ): Promise<NormalizedExecutionResult> {
    const resultPromise = handle.result().catch((error: unknown) => {
      const d = toDiagnostic(error, 'executor_result_failed');
      return synth('failed', d.code, d.safeMessage, d.retryable);
    });

    const first = await Promise.race([resultPromise, abortedPromise(stop)]);
    if (first !== undefined) return first;

    const byDeadline = !cancelled.aborted && stop.reason instanceof DeadlineReached;
    try {
      await handle.cancel(byDeadline ? 'deadline' : reason());
    } catch (error) {
      this.#logger.warn({ attemptId: handle.attemptId, error: toDiagnostic(error) }, 'cancel request failed');
    }

    const grace = new AbortController();
    const graced = await Promise.race([
      resultPromise,
      sleep(this.#clock, this.#graceMs, grace.signal).then(
        () => undefined,
        () => undefined,
      ),
    ]);
    grace.abort();

    if (graced === undefined) {
      return byDeadline
        ? synth('timed_out', 'deadline_exceeded', 'attempt exceeded its deadline', true)
        : synth('cancelled', 'cancel_unconfirmed', 'executor did not confirm cancellation');
    }
    if (graced.terminalStatus === 'completed') return { ...graced, afterCancel: true };
    if (byDeadline && graced.terminalStatus === 'cancelled') {
      return {
        ...graced,
        terminalStatus: 'timed_out',
        diagnostics: [...graced.diagnostics, diagnostic('deadline_exceeded', 'attempt exceeded its deadline', true)],
      };
    }
    return graced;
  }

  #updateBreaker(breaker: CircuitBreaker, result: NormalizedExecutionResult): void {
    const verdict = breakerVerdict(result);
    if (verdict === 'success') breaker.onSuccess();
    else if (verdict === 'failure') breaker.onFailure(result.diagnostics[0]?.code ?? result.terminalStatus);
    else breaker.onNeutral();
  }

  #reportQueue(): void {
    this.#metrics.set('dvo_scheduler_queue_length', this.#global.waiting, { pool: 'global' });
    this.#metrics.set('dvo_scheduler_queue_length', this.#perExecutor.waiting(), { pool: 'executor' });
  }
}

/** How an attempt's outcome counts against the executor's circuit. */
export function breakerVerdict(result: NormalizedExecutionResult): 'success' | 'failure' | 'neutral' {
  switch (result.terminalStatus) {
    case 'completed':
    case 'refused':
      return 'success';
    case 'cancelled':
      return 'neutral';
    case 'timed_out':
    case 'invalid_output':
      return 'failure';
    case 'failed':
      return result.diagnostics.some((d) => d.code === 'circuit_open') ? 'neutral' : 'failure';
  }
}

function abortedPromise(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
}
