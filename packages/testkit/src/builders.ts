import {
  type Claim,
  type Correlation,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceTier,
  EventId,
  TaskId,
  TraceId,
} from '@dvo/core';

export function correlation(overrides: Partial<Correlation> = {}): Correlation {
  return {
    taskId: TaskId('tsk_test'),
    traceId: TraceId('a'.repeat(32)),
    eventId: EventId('evt_test'),
    idempotencyKey: 'tsk_test/att_test',
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function claim(statement: string, overrides: Partial<Claim> = {}): Claim {
  return { id: 'answer', statement, confidence: 0.8, assumptions: [], dependencies: [], status: 'proposed', ...overrides };
}

export function envelope(
  answer: string,
  options: { correlation?: Correlation; tier?: EvidenceTier; confidence?: number; claims?: Claim[] } = {},
): EvidenceEnvelope {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    correlation: options.correlation ?? correlation(),
    tier: options.tier ?? 1,
    taskScope: 'test task',
    claims: options.claims ?? [claim(answer, { confidence: options.confidence ?? 0.8 })],
    evidence: [],
    redactionApplied: false,
  };
}
