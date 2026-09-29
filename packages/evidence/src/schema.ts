import { type Correlation, EVIDENCE_SCHEMA_VERSION, type EvidenceEnvelope } from '@dvo/core';
import { z } from 'zod';

/** Hard size limits applied at every inbound boundary (design §6.3.1). */
export const ENVELOPE_LIMITS = {
  maxEnvelopeBytes: 256 * 1024,
  maxClaims: 64,
  maxEvidence: 64,
  maxIdChars: 128,
  maxStatementChars: 4000,
  maxSummaryChars: 4000,
  maxTaskScopeChars: 8000,
  maxListItems: 32,
  maxListItemChars: 500,
  maxUriChars: 2048,
  maxHintChars: 1000,
  maxNextActionChars: 1000,
} as const;

const L = ENVELOPE_LIMITS;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

const shortList = z.array(z.string().max(L.maxListItemChars)).max(L.maxListItems);

export const ClaimSchema = z.object({
  id: z.string().min(1).max(L.maxIdChars),
  statement: z.string().max(L.maxStatementChars),
  confidence: z.number().min(0).max(1).default(0),
  assumptions: shortList.default([]),
  dependencies: shortList.default([]),
  status: z.enum(['proposed', 'supported', 'verified', 'refuted']).default('proposed'),
});

export const EvidenceItemSchema = z.object({
  kind: z.enum(['citation', 'tool-result', 'test-result', 'artifact', 'observation']),
  summary: z.string().max(L.maxSummaryChars),
  uri: z.string().max(L.maxUriChars).optional(),
  sha256: z.string().regex(SHA256, 'sha256 must be 64 lowercase hex characters').optional(),
  mimeType: z.string().regex(MIME, 'invalid MIME type').optional(),
  bytes: z.number().int().nonnegative().optional(),
  verifierHint: z.string().max(L.maxHintChars).optional(),
});

export const CorrelationSchema = z.object({
  taskId: z.string().min(1).max(L.maxIdChars),
  attemptId: z.string().min(1).max(L.maxIdChars).optional(),
  traceId: z.string().min(1).max(L.maxIdChars),
  eventId: z.string().min(1).max(L.maxIdChars),
  parentEventId: z.string().min(1).max(L.maxIdChars).optional(),
  idempotencyKey: z.string().min(1).max(256),
  occurredAt: z.iso.datetime({ offset: true }),
});

/**
 * Wire form of an envelope as produced by an untrusted executor: correlation is optional
 * (models and peers need not echo it; the bridge supplies the trusted one) and most fields
 * default so a minimal `{claims:[{id,statement}]}` is accepted.
 */
export const EnvelopeWireSchema = z.object({
  schemaVersion: z
    .string()
    .regex(/^1\.\d+$/, 'unsupported schemaVersion (expected 1.x)')
    .default(EVIDENCE_SCHEMA_VERSION),
  correlation: CorrelationSchema.optional(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  taskScope: z.string().max(L.maxTaskScopeChars).default(''),
  claims: z.array(ClaimSchema).max(L.maxClaims),
  evidence: z.array(EvidenceItemSchema).max(L.maxEvidence).default([]),
  requestedNextAction: z.string().max(L.maxNextActionChars).optional(),
  redactionApplied: z.boolean().default(false),
});

/** The full, trusted-shape envelope (as persisted and exchanged by this system). */
export const EnvelopeSchema = EnvelopeWireSchema.extend({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  correlation: CorrelationSchema,
});

const KNOWN_KEYS = {
  envelope: new Set(Object.keys(EnvelopeWireSchema.shape)),
  correlation: new Set(Object.keys(CorrelationSchema.shape)),
  claim: new Set(Object.keys(ClaimSchema.shape)),
  evidence: new Set(Object.keys(EvidenceItemSchema.shape)),
};

export type ParseEnvelopeResult =
  | { ok: true; envelope: EvidenceEnvelope; unknownFields: string[]; bytes: number }
  | { ok: false; issues: string[]; unknownFields: string[]; bytes: number };

/**
 * Structural validation of an untrusted envelope. Unknown fields are reported (for the
 * audit record) and stripped (so they can never reach a prompt). The trusted correlation
 * of the request replaces whatever the producer sent; a producer-supplied correlation for
 * a different task is rejected outright.
 */
export function parseEnvelope(raw: unknown, trusted: Correlation): ParseEnvelopeResult {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
  } catch {
    return { ok: false, issues: ['envelope is not JSON-serialisable'], unknownFields: [], bytes: 0 };
  }
  if (bytes > L.maxEnvelopeBytes) {
    return { ok: false, issues: [`envelope exceeds ${L.maxEnvelopeBytes} bytes`], unknownFields: [], bytes };
  }
  const unknownFields = collectUnknownFields(raw);
  const parsed = EnvelopeWireSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      unknownFields,
      bytes,
    };
  }
  const wire = parsed.data;
  if (wire.correlation !== undefined && wire.correlation.taskId !== trusted.taskId) {
    return { ok: false, issues: ['correlation.taskId does not match the request'], unknownFields, bytes };
  }
  const envelope: EvidenceEnvelope = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    correlation: trusted,
    tier: wire.tier,
    taskScope: wire.taskScope,
    claims: wire.claims,
    evidence: wire.evidence.map(stripUndefined),
    ...(wire.requestedNextAction === undefined ? {} : { requestedNextAction: wire.requestedNextAction }),
    redactionApplied: wire.redactionApplied,
  };
  return { ok: true, envelope, unknownFields, bytes };
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function stripUndefined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}

function collectUnknownFields(raw: unknown): string[] {
  const unknown: string[] = [];
  const scan = (value: unknown, known: Set<string>, path: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) if (!known.has(key)) unknown.push(path ? `${path}.${key}` : key);
  };
  scan(raw, KNOWN_KEYS.envelope, '');
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    scan(record['correlation'], KNOWN_KEYS.correlation, 'correlation');
    if (Array.isArray(record['claims'])) record['claims'].forEach((c, i) => scan(c, KNOWN_KEYS.claim, `claims[${i}]`));
    if (Array.isArray(record['evidence'])) record['evidence'].forEach((e, i) => scan(e, KNOWN_KEYS.evidence, `evidence[${i}]`));
  }
  return unknown.slice(0, 64);
}

/** JSON Schema of the wire envelope, published under schemas/ for non-TypeScript peers. */
export function envelopeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EnvelopeWireSchema, { target: 'draft-2020-12', io: 'input' });
}
