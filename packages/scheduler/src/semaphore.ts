import { CancelledError } from '@dvo/core';

/** Releases a permit. Idempotent: calling it twice releases once. */
export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** FIFO counting semaphore with abortable waits. */
export class Semaphore {
  #available: number;
  readonly #capacity: number;
  readonly #queue: Waiter[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) throw new RangeError('semaphore permits must be a positive integer');
    this.#available = permits;
    this.#capacity = permits;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get available(): number {
    return this.#available;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  tryAcquire(): Release | undefined {
    if (this.#available === 0 || this.#queue.length > 0) return undefined;
    this.#available -= 1;
    return this.#releaser();
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    const immediate = this.tryAcquire();
    if (immediate !== undefined) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.reject(new CancelledError('semaphore wait aborted'));
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(new CancelledError('semaphore wait aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next === undefined) {
        this.#available += 1;
        return;
      }
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve(this.#releaser());
    };
  }
}

/** One semaphore per key (e.g. per peer), so a slow peer cannot starve the others (design §10.3). */
export class KeyedSemaphore {
  readonly #limit: (key: string) => number;
  readonly #semaphores = new Map<string, Semaphore>();

  constructor(limit: (key: string) => number) {
    this.#limit = limit;
  }

  get(key: string): Semaphore {
    let semaphore = this.#semaphores.get(key);
    if (semaphore === undefined) {
      semaphore = new Semaphore(Math.max(1, Math.floor(this.#limit(key))));
      this.#semaphores.set(key, semaphore);
    }
    return semaphore;
  }

  acquire(key: string, signal?: AbortSignal): Promise<Release> {
    return this.get(key).acquire(signal);
  }

  waiting(): number {
    let total = 0;
    for (const semaphore of this.#semaphores.values()) total += semaphore.waiting;
    return total;
  }
}
