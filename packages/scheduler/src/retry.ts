import { CancelledError, type Clock, isHarnessError, sleep } from '@dvo/core';

export interface RetryPolicy {
  /** Total tries including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
  /** AWS-style: `full` = U(0, d), `equal` = d/2 + U(0, d/2), `none` = d. */
  jitter: 'full' | 'equal' | 'none';
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  multiplier: 2,
  jitter: 'full',
};

/** Delay before retry number `retry` (1-based). */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exponential = policy.baseDelayMs * (policy.multiplier ?? 2) ** Math.max(0, retry - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  switch (policy.jitter) {
    case 'none':
      return capped;
    case 'equal':
      return capped / 2 + random() * (capped / 2);
    case 'full':
      return random() * capped;
  }
}

/** Default classification: only errors that say so are retried. */
export function isRetryableError(error: unknown): boolean {
  return isHarnessError(error) && error.retryable;
}

export interface RetryOptions {
  policy: RetryPolicy;
  clock: Clock;
  isRetryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
  random?: () => number;
  onRetry?: (error: unknown, retry: number, delayMs: number) => void;
}

/** Retries `operation` with jittered exponential backoff, only for retryable errors. */
export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const retryable = options.isRetryable ?? isRetryableError;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw new CancelledError('retry aborted');
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.policy.maxAttempts || !retryable(error) || options.signal?.aborted) throw error;
      const delay = backoffDelay(attempt, options.policy, options.random);
      options.onRetry?.(error, attempt, delay);
      await sleep(options.clock, delay, options.signal);
    }
  }
}
