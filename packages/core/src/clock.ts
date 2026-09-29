import { CancelledError } from './errors.ts';

export interface TimerHandle {
  cancel(): void;
}

/**
 * Time is a port. Every deadline, backoff and timeout in the system goes through
 * a Clock so that tests can use a fake clock and evaluations a virtual one.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimer(delayMs: number, callback: () => void): TimerHandle;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Resolves after `delayMs` on `clock`; rejects with CancelledError if `signal` aborts first. */
export function sleep(clock: Clock, delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError('sleep aborted'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      timer.cancel();
      reject(new CancelledError('sleep aborted'));
    };
    const timer = clock.setTimer(delayMs, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An AbortSignal that fires at `deadlineMs` (absolute, on `clock`) or when `parent` aborts.
 * `dispose` must be called once the guarded work settles to release the timer.
 */
export function deadlineSignal(clock: Clock, deadlineMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer = clock.setTimer(deadlineMs - clock.now(), () => abort(new DeadlineReached()));
  const onParent = (): void => abort(parent?.reason);
  if (parent?.aborted) abort(parent.reason);
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      timer.cancel();
      parent?.removeEventListener('abort', onParent);
    },
  };
}

/** Abort reason used when a deadline (rather than an explicit cancel) fired. */
export class DeadlineReached extends Error {
  constructor() {
    super('deadline reached');
    this.name = 'DeadlineReached';
  }
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`invalid ISO-8601 timestamp: ${iso}`);
  return ms;
}
