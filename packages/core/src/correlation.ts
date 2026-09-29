import type { AttemptId, EventId, TaskId, TraceId } from './ids.ts';

/** Carried by every cross-module call (design §5.1). */
export interface Correlation {
  taskId: TaskId;
  attemptId?: AttemptId;
  traceId: TraceId;
  eventId: EventId;
  parentEventId?: EventId;
  /**
   * Application-level de-duplication key for one remote submission or local side effect.
   * Third-party A2A peers are not assumed to honour it (no exactly-once claim).
   */
  idempotencyKey: string;
  /** ISO-8601 UTC. */
  occurredAt: string;
}

/** W3C `traceparent` header value for propagating `traceId` to A2A peers. */
export function traceparent(traceId: TraceId, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}
