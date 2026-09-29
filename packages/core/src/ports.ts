import type { DecisionRecord } from './actions.ts';
import type { Correlation } from './correlation.ts';
import type { EvidenceEnvelope } from './evidence.ts';
import type { DomainEvent } from './events.ts';
import type { TerminalStatus } from './execution.ts';
import type { AttemptId, PeerId, TaskId } from './ids.ts';
import type { OutboxRecord, OutboxState } from './outbox.ts';
import type { CircuitState } from './policy-input.ts';
import type { LatencyHistogramData } from './stats.ts';
import type { TaskPhase, TaskState, VerificationSpec } from './task.ts';
import type { TrustTier } from './classification.ts';

// ─── Persistence ────────────────────────────────────────────────────────────────

/** One atomic write: events + resulting projection (+ outbox rows), guarded by CAS on revision. */
export interface TaskCommit {
  taskId: TaskId;
  /** Revision the writer based its events on; 0 when creating the task. */
  expectedRevision: number;
  events: readonly DomainEvent[];
  /** Projection after applying `events`; `state.revision === expectedRevision + events.length`. */
  state: TaskState;
  /** Outbox rows written in the same transaction as the attempt that owns them. */
  outbox?: readonly OutboxRecord[];
}

export interface TaskSummary {
  taskId: TaskId;
  phase: TaskPhase;
  revision: number;
  classification: string;
  createdAt: string;
  updatedAt: string;
  clientRequestKey?: string;
}

export interface TaskRepository {
  /** Throws RevisionConflictError when the stored revision is not `expectedRevision`. */
  commit(commit: TaskCommit): Promise<void>;
  load(taskId: TaskId): Promise<TaskState | undefined>;
  events(taskId: TaskId): Promise<DomainEvent[]>;
  decisions(taskId: TaskId): Promise<DecisionRecord[]>;
  findByClientKey(clientRequestKey: string): Promise<TaskId | undefined>;
  listTasks(filter?: { nonTerminal?: boolean; limit?: number }): Promise<TaskSummary[]>;
}

export interface OutboxPatch {
  remoteTaskId?: string;
  lastError?: string;
  incrementSendCount?: boolean;
}

export interface OutboxRepository {
  getOutbox(attemptId: AttemptId): Promise<OutboxRecord | undefined>;
  /** Compare-and-set on `state`; throws IllegalTransitionError / RevisionConflictError on mismatch. */
  transitionOutbox(
    attemptId: AttemptId,
    expected: OutboxState | readonly OutboxState[],
    to: OutboxState,
    patch?: OutboxPatch,
  ): Promise<OutboxRecord>;
  listOutbox(states: readonly OutboxState[]): Promise<OutboxRecord[]>;
}

/** One settled observation of an executor, keyed by attempt so recording is idempotent. */
export interface ExecutorOutcome {
  attemptId: AttemptId;
  executorId: string;
  skill: string;
  success: boolean;
  terminalStatus: TerminalStatus;
  latencyMs: number;
  costUsd: number;
  artifactFailure: boolean;
  at: string;
}

export interface ExecutorStats {
  executorId: string;
  skill: string;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  cancelCount: number;
  artifactFailureCount: number;
  totalCostUsd: number;
  latency: LatencyHistogramData;
}

export interface PeerRecord {
  peerId: PeerId;
  trustTier: TrustTier;
  cardDigest?: string;
  lastSeenAt?: string;
  circuit: CircuitState;
  circuitChangedAt?: string;
}

export interface ReliabilityRepository {
  /** Returns false when an outcome for the same attempt was already recorded. */
  recordOutcome(outcome: ExecutorOutcome): Promise<boolean>;
  executorStats(): Promise<ExecutorStats[]>;
  upsertPeer(record: PeerRecord): Promise<void>;
  listPeers(): Promise<PeerRecord[]>;
}

export interface ArtifactRecord {
  sha256: string;
  attemptId: AttemptId;
  uri?: string;
  mimeType?: string;
  bytes: number;
  validationStatus: 'accepted' | 'rejected' | 'quarantined';
  reason?: string;
  storedPath?: string;
  recordedAt: string;
}

export interface ArtifactRepository {
  putArtifact(record: ArtifactRecord): Promise<void>;
  getArtifact(sha256: string): Promise<ArtifactRecord | undefined>;
}

export interface HarnessStore extends TaskRepository, OutboxRepository, ReliabilityRepository, ArtifactRepository {
  close(): Promise<void>;
}

// ─── Verification ───────────────────────────────────────────────────────────────

export interface VerificationInput {
  correlation: Correlation;
  candidate: EvidenceEnvelope;
  spec: VerificationSpec;
}

export interface VerificationOutcome {
  outcome: 'verified' | 'refuted' | 'inconclusive';
  claimVerdicts: Array<{ claimId: string; verdict: 'verified' | 'refuted' | 'inconclusive' }>;
  detail?: string;
}

/** A local, deterministic check. LLM judges are deliberately not modelled as verifiers (design §4.1). */
export interface Verifier {
  readonly id: string;
  readonly deterministic: boolean;
  available(): Promise<boolean>;
  verify(input: VerificationInput, signal: AbortSignal): Promise<VerificationOutcome>;
}

// ─── Observability ──────────────────────────────────────────────────────────────

/** Structured logger (pino-compatible subset). Callers pass already-redacted fields. */
export interface Logger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

// ─── Secrets ────────────────────────────────────────────────────────────────────

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');

/**
 * A resolved credential. Every accidental stringification (template literal, JSON,
 * util.inspect, logger serialiser) yields `[REDACTED]`; only `reveal()` returns the value.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [inspectSymbol](): string {
    return 'SecretValue([REDACTED])';
  }
}

export interface SecretProvider {
  /** Resolves a `secret://…` reference. Throws if it cannot be resolved. */
  resolve(ref: string): Promise<SecretValue>;
}
