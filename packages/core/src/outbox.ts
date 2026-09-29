import { IllegalTransitionError } from './errors.ts';
import type { AttemptId, PeerId, TaskId } from './ids.ts';

/**
 * Transactional-outbox state of one remote submission (design §11.1).
 *
 *   pending ──▶ sending ──▶ submitted
 *                  │
 *                  └──▶ submission_unknown ──▶ sending (only for de-duplicating peers)
 *   any non-submitted ──▶ abandoned
 *
 * `pending` means "never left the process" and is always safe to send. `sending` found
 * after a crash is indistinguishable from `submission_unknown`.
 */
export type OutboxState = 'pending' | 'sending' | 'submitted' | 'submission_unknown' | 'abandoned';

const OUTBOX_TRANSITIONS: Record<OutboxState, readonly OutboxState[]> = {
  pending: ['sending', 'abandoned'],
  sending: ['submitted', 'submission_unknown', 'pending', 'abandoned'],
  submission_unknown: ['sending', 'submitted', 'abandoned'],
  submitted: [],
  abandoned: [],
};

export function assertOutboxTransition(from: OutboxState, to: OutboxState): void {
  if (!OUTBOX_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError('outbox', from, to);
}

export interface OutboxRecord {
  attemptId: AttemptId;
  taskId: TaskId;
  peerId: PeerId;
  state: OutboxState;
  /** SHA-256 of the canonical wire request; fixed at creation, never recomputed. */
  requestDigest: string;
  idempotencyKey: string;
  /** Minimised, redacted outbound payload, so a restart can send exactly the same bytes. */
  payload: unknown;
  remoteTaskId?: string;
  sendCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
