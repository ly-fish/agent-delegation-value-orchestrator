import type { PolicyVerifierView, Verifier } from '@dvo/core';
import { VerifierExecutor } from './executor.ts';

/** The verifiers configured for this process, each wrapped as a schedulable executor. */
export class VerifierRegistry {
  readonly #executors = new Map<string, VerifierExecutor>();
  readonly #now: () => number;

  constructor(verifiers: readonly Verifier[] = [], now: () => number = Date.now) {
    this.#now = now;
    for (const verifier of verifiers) this.register(verifier);
  }

  register(verifier: Verifier): this {
    if (this.#executors.has(verifier.id)) throw new RangeError(`verifier "${verifier.id}" registered twice`);
    this.#executors.set(verifier.id, new VerifierExecutor(verifier, this.#now));
    return this;
  }

  has(id: string): boolean {
    return this.#executors.has(id);
  }

  executor(id: string): VerifierExecutor | undefined {
    return this.#executors.get(id);
  }

  ids(): string[] {
    return [...this.#executors.keys()];
  }

  /** Health snapshot for the policy input. */
  async views(): Promise<PolicyVerifierView[]> {
    return Promise.all(
      [...this.#executors.values()].map(async (e) => ({
        id: e.verifier.id,
        deterministic: e.verifier.deterministic,
        available: await e.verifier.available().catch(() => false),
      })),
    );
  }
}
