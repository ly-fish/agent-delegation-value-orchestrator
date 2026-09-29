import type { Clock, TimerHandle } from '@dvo/core';

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * Deterministic clock for tests and simulations. Time only moves when told to; timers fire
 * in (deadline, creation) order. `runUntilSettled` auto-advances to the next timer whenever
 * the event loop has gone quiet, which lets whole-engine simulations run in virtual time.
 */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers: Timer[] = [];

  constructor(startMs = Date.UTC(2026, 0, 1)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, callback: () => void): TimerHandle {
    const timer: Timer = { id: this.#nextId++, at: this.#now + Math.max(0, delayMs), callback };
    this.#timers.push(timer);
    return { cancel: () => void (this.#timers = this.#timers.filter((t) => t !== timer)) };
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  nextTimerAt(): number | undefined {
    return this.#sorted()[0]?.at;
  }

  /** Advances time by `ms`, firing due timers in order and flushing the event loop after each. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flush();
      const next = this.#sorted()[0];
      if (next === undefined || next.at > target) break;
      this.#now = next.at;
      this.#timers = this.#timers.filter((t) => t !== next);
      next.callback();
    }
    this.#now = target;
    await flush();
  }

  /** Jumps straight to the next timer (if any) and fires it. */
  async advanceToNextTimer(): Promise<boolean> {
    await flush();
    const next = this.#sorted()[0];
    if (next === undefined) return false;
    await this.advance(next.at - this.#now);
    return true;
  }

  /**
   * Virtual-time driver: keeps flushing the event loop and, whenever it is idle, jumps to
   * the next timer — until `done` settles or `maxSteps` timers have fired.
   */
  async runUntilSettled<T>(done: Promise<T>, maxSteps = 100_000): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    done.then(
      (v) => {
        settled = true;
        value = v;
      },
      (e: unknown) => {
        settled = true;
        failed = true;
        failure = e;
      },
    );
    for (let step = 0; step < maxSteps; step++) {
      await flush();
      if (settled) break;
      if (!(await this.advanceToNextTimer())) {
        await flush(20);
        if (settled) break;
        if (this.#timers.length === 0) throw new Error('FakeClock.runUntilSettled: deadlock (no timers, promise pending)');
      }
    }
    if (!settled) throw new Error('FakeClock.runUntilSettled: step limit reached');
    if (failed) throw failure;
    return value as T;
  }

  #sorted(): Timer[] {
    return [...this.#timers].sort((a, b) => a.at - b.at || a.id - b.id);
  }
}

/** Lets pending promise callbacks and immediate callbacks run. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
