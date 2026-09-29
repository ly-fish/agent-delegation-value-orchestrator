import {
  ANSWER_CLAIM_ID,
  diagnostic,
  type Diagnostic,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceItem,
  type ExecutionRequest,
  sha256Hex,
  type TerminalStatus,
  uuidv5,
} from '@dvo/core';
import { minimise, parseEnvelope } from '@dvo/evidence';
import type { PeerProfile } from './card-resolver.ts';
import { type Artifact, EVIDENCE_EXTENSION_URI, type Message, type Part, type Task, type TaskState } from './wire.ts';

/** Wire parameters of a SendMessage call, as frozen in the outbox. */
export interface SendMessageParams {
  message: Message;
  configuration: { acceptedOutputModes: string[]; historyLength: number; returnImmediately: boolean };
}

/**
 * ExecutionRequest → A2A SendMessage (design §9.2). The `messageId` is derived from the
 * idempotency key, so a resubmission is byte-identical. The evidence envelope travels as a
 * Data Part; with the DVO extension active it is tagged and accompanied by the idempotency
 * key and requested tier, otherwise it is minimised to tier 0 (design §9.3.3).
 */
export function buildSendMessageParams(request: ExecutionRequest, profile: PeerProfile): SendMessageParams {
  const extension = profile.supportsEvidenceExtension;
  const parts: Part[] = [{ text: request.prompt, mediaType: 'text/plain' }];
  if (request.evidence !== undefined) {
    const envelope = extension ? request.evidence : minimise(request.evidence, 0);
    parts.push({
      data: envelope,
      mediaType: 'application/json',
      ...(extension ? { metadata: { [EVIDENCE_EXTENSION_URI]: { kind: 'evidence-envelope' } } } : {}),
    });
  }
  const message: Message = {
    messageId: uuidv5(request.correlation.idempotencyKey),
    role: 'ROLE_USER',
    parts,
    ...(extension
      ? {
          extensions: [EVIDENCE_EXTENSION_URI],
          metadata: {
            [EVIDENCE_EXTENSION_URI]: {
              schemaVersion: EVIDENCE_SCHEMA_VERSION,
              idempotencyKey: request.correlation.idempotencyKey,
              requestedTier: request.requestedTier,
              taskScopeOnly: true,
            },
          },
        }
      : {}),
  };
  return {
    message,
    configuration: { acceptedOutputModes: ['application/json', 'text/plain'], historyLength: 0, returnImmediately: true },
  };
}

export function terminalStatusOf(state: TaskState): TerminalStatus | undefined {
  switch (state) {
    case 'TASK_STATE_COMPLETED':
      return 'completed';
    case 'TASK_STATE_FAILED':
      return 'failed';
    case 'TASK_STATE_CANCELED':
      return 'cancelled';
    case 'TASK_STATE_REJECTED':
      return 'refused';
    case 'TASK_STATE_INPUT_REQUIRED':
    case 'TASK_STATE_AUTH_REQUIRED':
      // Single-hop, read-only MVP: we never supply follow-up input to a peer.
      return 'failed';
    default:
      return undefined;
  }
}

export interface ExtractedOutput {
  envelope?: EvidenceEnvelope;
  issues: string[];
  unknownFields: string[];
  /** Inline `raw` artifact bytes, for the quarantine store. */
  rawArtifacts: Array<{ bytes: Uint8Array; sha256: string; mimeType?: string }>;
  synthesized: boolean;
}

/**
 * A2A Task → EvidenceEnvelope, in order of preference: an envelope tagged with the DVO
 * extension; any Data Part shaped like an envelope; otherwise a synthesized tier-0
 * envelope holding the text answer (self-reported confidence 0: no claim of certainty).
 * File parts become artifact evidence (checked later by the gateway, never fetched here).
 */
export function extractOutput(task: Task, request: ExecutionRequest, options: { maxRawBytes: number }): ExtractedOutput {
  const issues: string[] = [];
  const artifacts = task.artifacts ?? [];
  const tagged = artifacts.filter(isTagged).flatMap((a) => a.parts.filter((p) => p.data !== undefined));
  const shaped = artifacts.flatMap((a) => a.parts).filter((p) => p.data !== undefined && looksLikeEnvelope(p.data));
  for (const part of [...tagged, ...shaped]) {
    const parsed = parseEnvelope(part.data, request.correlation);
    if (parsed.ok) return { envelope: parsed.envelope, issues, unknownFields: parsed.unknownFields, rawArtifacts: [], synthesized: false };
    issues.push(...parsed.issues.slice(0, 3));
  }

  const sourceParts = artifacts.length > 0 ? artifacts.flatMap((a) => a.parts) : (task.status.message?.parts ?? []);
  const texts = sourceParts.flatMap((p) => (p.text === undefined ? [] : [p.text]));
  const evidence: EvidenceItem[] = [];
  const rawArtifacts: ExtractedOutput['rawArtifacts'] = [];
  for (const part of sourceParts) {
    if (part.url !== undefined) {
      evidence.push({
        kind: 'artifact',
        summary: (part.filename ?? 'artifact').slice(0, 200),
        uri: part.url,
        ...(part.mediaType === undefined ? {} : { mimeType: part.mediaType }),
        ...(typeof part.metadata?.['sha256'] === 'string' ? { sha256: part.metadata['sha256'] } : {}),
        ...(typeof part.metadata?.['bytes'] === 'number' ? { bytes: part.metadata['bytes'] } : {}),
      });
    } else if (part.raw !== undefined) {
      const bytes = Buffer.from(part.raw, 'base64');
      if (bytes.byteLength > options.maxRawBytes) {
        issues.push('inline artifact exceeds the size limit and was dropped');
        continue;
      }
      const sha256 = sha256Hex(bytes);
      rawArtifacts.push({ bytes, sha256, ...(part.mediaType === undefined ? {} : { mimeType: part.mediaType }) });
      evidence.push({
        kind: 'artifact',
        summary: (part.filename ?? 'inline artifact').slice(0, 200),
        sha256,
        bytes: bytes.byteLength,
        ...(part.mediaType === undefined ? {} : { mimeType: part.mediaType }),
      });
    }
  }
  if (texts.length === 0)
    return { issues: [...issues, 'task completed without a usable answer'], unknownFields: [], rawArtifacts, synthesized: false };
  const envelope: EvidenceEnvelope = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    correlation: request.correlation,
    tier: evidence.length > 0 ? 1 : 0,
    taskScope: '',
    claims: [
      {
        id: ANSWER_CLAIM_ID,
        statement: texts.join('\n').slice(0, 4000),
        confidence: 0,
        assumptions: [],
        dependencies: [],
        status: 'proposed',
      },
    ],
    evidence: evidence.slice(0, 64),
    redactionApplied: false,
  };
  return { envelope, issues, unknownFields: [], rawArtifacts, synthesized: true };
}

function isTagged(artifact: Artifact): boolean {
  return artifact.extensions?.includes(EVIDENCE_EXTENSION_URI) === true || artifact.metadata?.[EVIDENCE_EXTENSION_URI] !== undefined;
}

function looksLikeEnvelope(data: unknown): boolean {
  return data !== null && typeof data === 'object' && Array.isArray((data as { claims?: unknown }).claims);
}

/** Safe, bounded summary of a peer's failure message for diagnostics. */
export function peerFailureDiagnostic(task: Task, code: string): Diagnostic {
  const text = task.status.message?.parts.flatMap((p) => (p.text === undefined ? [] : [p.text])).join(' ') ?? '';
  const summary = text === '' ? task.status.state : text.slice(0, 300);
  return diagnostic(code, `peer reported ${task.status.state}: ${summary}`, false);
}
