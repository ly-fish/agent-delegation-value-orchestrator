import type { CircuitState, Clock } from '@dvo/core';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** Time spent open before a half-open probe is allowed. */
  cooldownMs: number;
  /** Concurrent probes admitted while half-open. */
  halfOpenMaxProbes: number;
  /** Consecutive half-open successes needed to close. */
  successThreshold: number;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  halfOpenMaxProbes: 1,
  successThreshold: 1,
};

export type CircuitListener = (id: string, from: CircuitState, to: CircuitState, reason: string) => void;

/**
 * Per-peer circuit breaker (design §10.2 "peer 连续失败"). An open circuit removes the peer
 * from the candidate pool until the cooldown passes (half-open probe) or an operator resets it.
 * A manually tripped circuit stays open until manually reset.
 */
export class CircuitBreaker {
  readonly id: string;
  readonly #options: CircuitBreakerOptions;
  readonly #clock: Clock;
  readonly #listener: CircuitListener | undefined;
  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #halfOpenSuccesses = 0;
  #probesInFlight = 0;
  #openedAt = 0;
  #manual = false;

  constructor(id: string, options: CircuitBreakerOptions, clock: Clock, listener?: CircuitListener) {
    this.id = id;
    this.#options = options;
    this.#clock = clock;
    this.#listener = listener;
  }

  /** Current state; an elapsed cooldown is reported as `half_open`. */
  get state(): CircuitState {
    if (this.#state === 'open' && !this.#manual && this.#clock.now() - this.#openedAt >= this.#options.cooldownMs) {
      this.#transition('half_open', 'cooldown elapsed');
    }
    return this.#state;
  }

  /** Whether a request may be sent now. In half-open, admitting a request reserves a probe slot. */
  tryAcquire(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half_open':
        if (this.#probesInFlight >= this.#options.halfOpenMaxProbes) return false;
        this.#probesInFlight += 1;
        return true;
    }
  }

  onSuccess(): void {
    if (this.#state === 'half_open') {
      this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
      this.#halfOpenSuccesses += 1;
      if (this.#halfOpenSuccesses >= this.#options.successThreshold) this.#transition('closed', 'probe succeeded');
      return;
    }
    this.#consecutiveFailures = 0;
  }

  onFailure(reason = 'failure'): void {
    if (this.#state === 'half_open') {
      this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
      this.#open(`probe failed: ${reason}`);
      return;
    }
    this.#consecutiveFailures += 1;
    if (this.#state === 'closed' && this.#consecutiveFailures >= this.#options.failureThreshold) {
      this.#open(`${this.#consecutiveFailures} consecutive failures (${reason})`);
    }
  }

  /** Neither success nor failure (e.g. a cancelled request): frees a half-open probe slot. */
  onNeutral(): void {
    if (this.#state === 'half_open') this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
  }

  /** Operator action: force open until `reset()`. */
  trip(reason = 'manual trip'): void {
    this.#manual = true;
    this.#open(reason);
  }

  /** Operator action: close and clear counters. */
  reset(reason = 'manual reset'): void {
    this.#manual = false;
    this.#transition('closed', reason);
  }

  #open(reason: string): void {
    this.#openedAt = this.#clock.now();
    this.#transition('open', reason);
  }

  #transition(to: CircuitState, reason: string): void {
    const from = this.#state;
    if (to === 'closed' || to === 'half_open') {
      this.#halfOpenSuccesses = 0;
      this.#probesInFlight = 0;
    }
    if (to === 'closed') this.#consecutiveFailures = 0;
    this.#state = to;
    if (from !== to) this.#listener?.(this.id, from, to, reason);
  }
}

export class CircuitRegistry {
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #options: (id: string) => CircuitBreakerOptions;
  readonly #clock: Clock;
  readonly #listener: CircuitListener | undefined;

  constructor(clock: Clock, options: (id: string) => CircuitBreakerOptions = () => DEFAULT_CIRCUIT_OPTIONS, listener?: CircuitListener) {
    this.#clock = clock;
    this.#options = options;
    this.#listener = listener;
  }

  get(id: string): CircuitBreaker {
    let breaker = this.#breakers.get(id);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(id, this.#options(id), this.#clock, this.#listener);
      this.#breakers.set(id, breaker);
    }
    return breaker;
  }

  states(): Record<string, CircuitState> {
    const out: Record<string, CircuitState> = {};
    for (const [id, breaker] of this.#breakers) out[id] = breaker.state;
    return out;
  }
}

export function circuitGaugeValue(state: CircuitState): number {
  return state === 'closed' ? 0 : state === 'half_open' ? 1 : 2;
}
