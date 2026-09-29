import type { Budget } from './budget.ts';
import type { DataClassification } from './classification.ts';
import type { Correlation } from './correlation.ts';
import type { EvidenceEnvelope, EvidenceTier } from './evidence.ts';
import type { AttemptId } from './ids.ts';
import type { OutboxRecord } from './outbox.ts';
import type { VerificationSpec } from './task.ts';

export type ExecutorKind = 'dsh-local' | 'a2a-peer' | 'verifier';

/** Runtime provenance written into every trace (design §8.2, §8.3). */
export interface RuntimeInfo {
  name: string;
  version: string;
  commit?: string;
  profile?: string;
  profileDigest?: string;
  modelRoute?: string;
}

export interface ExecutorCapabilities {
  kind: ExecutorKind;
  skills: readonly string[];
  /** Highest evidence tier this executor can exchange (e.g. 0 for A2A peers without the extension). */
  maxEvidenceTier: EvidenceTier;
  supportsCancel: boolean;
  /** Whether an interrupted attempt can be re-attached after a restart. */
  supportsResume: boolean;
  /** Only for peers under our control that de-duplicate by idempotency key / messageId. */
  supportsIdempotentResubmit: boolean;
  available: boolean;
  degradedReason?: string;
  runtime?: RuntimeInfo;
}

export interface VerificationRequest {
  targetAttemptId: AttemptId;
  candidate: EvidenceEnvelope;
  spec: VerificationSpec;
}

/** What the core hands an executor (design §8.1). Contains only minimised, redacted data. */
export interface ExecutionRequest {
  correlation: Correlation;
  prompt: string;
  expectedSchema?: object;
  budget: Pick<Budget, 'maxInputTokens' | 'maxOutputTokens' | 'deadlineAt'>;
  evidence?: EvidenceEnvelope;
  requestedTier: EvidenceTier;
  classification: DataClassification;
  skill?: string;
  verification?: VerificationRequest;
}

/** Side-channel progress an executor reports while an attempt is running. */
export type ExecutionProgress =
  | { kind: 'started' }
  | { kind: 'remote_submitted'; remoteTaskId: string; requestDigest: string }
  | { kind: 'submission_unknown'; reason: string }
  | { kind: 'remote_state'; state: string }
  | { kind: 'observation_ignored'; reason: string };

export interface ExecutionObserver {
  onProgress(progress: ExecutionProgress): void;
}

export const NOOP_OBSERVER: ExecutionObserver = { onProgress: () => undefined };

export interface ExecutionHandle {
  attemptId: AttemptId;
  /** Best-effort. Resolves once the cancellation request has been issued, not when it took effect. */
  cancel(reason?: string): Promise<void>;
  /** Resolves exactly once and never rejects: failures are expressed as terminal statuses. */
  result(): Promise<NormalizedExecutionResult>;
}

/** Everything needed to re-attach to an attempt after a restart. */
export interface ResumeRef {
  request: ExecutionRequest;
  submission?: OutboxRecord;
}

/**
 * A remote submission frozen before it is sent (transactional outbox, design §11.1): the
 * engine persists `payload` and `requestDigest` atomically with the attempt, and `start`
 * then sends exactly those bytes.
 */
export interface PreparedSubmission {
  payload: unknown;
  requestDigest: string;
}

export interface Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  capabilities(): Promise<ExecutorCapabilities>;
  /** Remote executors only: build the wire request so it can be persisted before sending. */
  prepare?(request: ExecutionRequest): Promise<PreparedSubmission>;
  start(request: ExecutionRequest, observer?: ExecutionObserver): Promise<ExecutionHandle>;
  resume?(ref: ResumeRef, observer?: ExecutionObserver): Promise<ExecutionHandle>;
}

export type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'refused' | 'invalid_output';

export interface Diagnostic {
  code: string;
  safeMessage: string;
  retryable: boolean;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  elapsedMs: number;
}

/**
 * Local DSH and remote A2A results are both normalised to this shape (design appendix A).
 * `output` is structurally valid but still untrusted: the evidence gateway decides what it
 * may claim before anything reads it.
 */
export interface NormalizedExecutionResult {
  correlation: Correlation;
  executorId: string;
  terminalStatus: TerminalStatus;
  output?: EvidenceEnvelope;
  rawOutputRef?: { sha256: string; storageUri: string };
  usage: Usage;
  diagnostics: Diagnostic[];
  runtime?: RuntimeInfo;
  remoteTaskId?: string;
  /** The result arrived after a cancel was requested (a "late" result, design §10.1). */
  afterCancel?: boolean;
}

export function diagnostic(code: string, safeMessage: string, retryable = false): Diagnostic {
  return { code, safeMessage, retryable };
}

export function isRetryableResult(result: NormalizedExecutionResult): boolean {
  if (result.terminalStatus === 'completed' || result.terminalStatus === 'refused') return false;
  return result.diagnostics.some((d) => d.retryable);
}
