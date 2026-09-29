export type ErrorCode =
  | 'budget_exceeded'
  | 'deadline_exceeded'
  | 'illegal_transition'
  | 'revision_conflict'
  | 'validation_failed'
  | 'peer_not_allowed'
  | 'circuit_open'
  | 'timeout'
  | 'cancelled'
  | 'protocol_error'
  | 'submission_unknown'
  | 'not_found'
  | 'unsafe_egress'
  | 'runtime_unavailable'
  | 'approval_required'
  | 'internal';

export interface HarnessErrorOptions {
  retryable?: boolean;
  cause?: unknown;
  /** Structured, non-sensitive context. Never put secrets or user content here. */
  details?: Record<string, unknown>;
}

/**
 * Base error for the control plane. `safeMessage` is the only text that may leave the
 * process (API responses, traces, remote peers); `message` may carry more detail for logs.
 */
export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, safeMessage: string, options: HarnessErrorOptions = {}) {
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.safeMessage = safeMessage;
    this.details = options.details;
  }
}

export class CancelledError extends HarnessError {
  constructor(safeMessage = 'operation cancelled', options: HarnessErrorOptions = {}) {
    super('cancelled', safeMessage, options);
  }
}

export class TimeoutError extends HarnessError {
  constructor(safeMessage = 'operation timed out', options: HarnessErrorOptions = {}) {
    super('timeout', safeMessage, { retryable: true, ...options });
  }
}

export class RevisionConflictError extends HarnessError {
  constructor(taskId: string, expected: number, actual: number | undefined) {
    super('revision_conflict', 'task state changed concurrently', {
      retryable: true,
      details: { taskId, expected, actual },
    });
  }
}

export class IllegalTransitionError extends HarnessError {
  constructor(entity: 'task' | 'attempt' | 'outbox', from: string, to: string) {
    super('illegal_transition', `illegal ${entity} transition ${from} -> ${to}`, {
      details: { entity, from, to },
    });
  }
}

export class ValidationError extends HarnessError {
  readonly issues: readonly string[];

  constructor(safeMessage: string, issues: readonly string[] = []) {
    super('validation_failed', safeMessage, { details: { issues } });
    this.issues = issues;
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError;
}

/** Reduce any thrown value to a diagnostic that is safe to persist and expose. */
export function toDiagnostic(
  error: unknown,
  fallbackCode = 'internal',
): {
  code: string;
  safeMessage: string;
  retryable: boolean;
} {
  if (isHarnessError(error)) {
    return { code: error.code, safeMessage: error.safeMessage, retryable: error.retryable };
  }
  return { code: fallbackCode, safeMessage: 'internal error', retryable: false };
}
