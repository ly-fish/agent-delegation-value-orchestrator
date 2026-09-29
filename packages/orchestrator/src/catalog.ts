import type { Clock, Executor, ExecutorCapabilities, PeerId, TrustTier } from '@dvo/core';
import type { VerifierRegistry } from '@dvo/verifier';

/** The local runtime as the orchestrator sees it (no DSH types). */
export interface LocalDescriptor {
  executor: Executor;
  /** Cost estimate per attempt until observed costs exist. */
  costEstimateUsd: number;
  timeoutMs: number;
  maxConcurrency: number;
}

/** A remote peer as the orchestrator sees it (no A2A types). */
export interface PeerDescriptor {
  peerId: PeerId;
  executor: Executor;
  trustTier: TrustTier;
  allowRestricted: boolean;
  costPerCallUsd: number;
  timeoutMs: number;
  maxConcurrency: number;
}

export interface ExecutorCatalog {
  local?: LocalDescriptor;
  peers: readonly PeerDescriptor[];
  verifiers: VerifierRegistry;
}

export function findPeer(catalog: ExecutorCatalog, peerId: PeerId | string): PeerDescriptor | undefined {
  return catalog.peers.find((p) => p.peerId === peerId);
}

/** Resolves an executor id (local, peer or `verifier:<id>`) to its executor. */
export function executorById(catalog: ExecutorCatalog, id: string): Executor | undefined {
  if (catalog.local?.executor.id === id) return catalog.local.executor;
  const peer = catalog.peers.find((p) => p.executor.id === id);
  if (peer !== undefined) return peer.executor;
  if (id.startsWith('verifier:')) return catalog.verifiers.executor(id.slice('verifier:'.length));
  return undefined;
}

/**
 * Short-lived cache of executor capabilities. Capabilities may require network I/O (an
 * Agent Card fetch); caching bounds decision latency, and failures are cached briefly too
 * so an unreachable peer does not stall every decision.
 */
export class CapabilityCache {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { at: number; value: Promise<ExecutorCapabilities> }>();

  constructor(clock: Clock, ttlMs = 30_000) {
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  get(executor: Executor): Promise<ExecutorCapabilities> {
    const now = this.#clock.now();
    const hit = this.#entries.get(executor.id);
    if (hit !== undefined && now - hit.at < this.#ttlMs) return hit.value;
    const value = executor.capabilities().catch((): ExecutorCapabilities => ({
      kind: executor.kind,
      skills: [],
      maxEvidenceTier: 0,
      supportsCancel: false,
      supportsResume: false,
      supportsIdempotentResubmit: false,
      available: false,
      degradedReason: 'capabilities unavailable',
    }));
    this.#entries.set(executor.id, { at: now, value });
    return value;
  }

  invalidate(executorId?: string): void {
    if (executorId === undefined) this.#entries.clear();
    else this.#entries.delete(executorId);
  }
}
