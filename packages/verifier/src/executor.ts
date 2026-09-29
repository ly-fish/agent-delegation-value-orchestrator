import {
  type AttemptId,
  CancelledError,
  type Claim,
  diagnostic,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type ExecutionHandle,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type NormalizedExecutionResult,
  type Verifier,
  type VerificationOutcome,
  isHarnessError,
} from '@dvo/core';

/** Claim id under which a verifier attempt reports its overall outcome. */
export const VERIFICATION_CLAIM_ID = 'verification.outcome';

/**
 * Adapts a Verifier to the Executor port so the orchestrator schedules, times out and
 * records verifications exactly like any other attempt. Only envelopes produced here may
 * carry `verified` claims (the evidence gateway demotes them from every other source).
 */
export class VerifierExecutor implements Executor {
  readonly id: string;
  readonly kind = 'verifier' as const;
  readonly verifier: Verifier;
  readonly #now: () => number;

  constructor(verifier: Verifier, now: () => number = Date.now) {
    this.verifier = verifier;
    this.id = `verifier:${verifier.id}`;
    this.#now = now;
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    const available = await this.verifier.available().catch(() => false);
    return {
      kind: 'verifier',
      skills: [],
      maxEvidenceTier: 2,
      supportsCancel: true,
      supportsResume: false,
      supportsIdempotentResubmit: true,
      available,
      ...(available ? {} : { degradedReason: 'verifier unavailable' }),
    };
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const started = this.#now();
    const controller = new AbortController();
    const base = { correlation: request.correlation, executorId: this.id };
    const elapsed = (): number => this.#now() - started;

    const work = async (): Promise<NormalizedExecutionResult> => {
      const verification = request.verification;
      if (verification === undefined) {
        return {
          ...base,
          terminalStatus: 'failed',
          usage: { elapsedMs: 0 },
          diagnostics: [diagnostic('verification_request_missing', 'no verification request')],
        };
      }
      try {
        const outcome = await this.verifier.verify(
          { correlation: request.correlation, candidate: verification.candidate, spec: verification.spec },
          controller.signal,
        );
        if (controller.signal.aborted) throw new CancelledError();
        return {
          ...base,
          terminalStatus: 'completed',
          output: verificationEnvelope(request, verification.candidate, outcome),
          usage: { elapsedMs: elapsed(), costUsd: 0 },
          diagnostics: [],
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            ...base,
            terminalStatus: 'cancelled',
            usage: { elapsedMs: elapsed() },
            diagnostics: [diagnostic('cancelled', 'verification cancelled')],
          };
        }
        const retryable = !isHarnessError(error) || error.retryable;
        const message = isHarnessError(error) ? error.safeMessage : 'verifier failed';
        return {
          ...base,
          terminalStatus: 'failed',
          usage: { elapsedMs: elapsed() },
          diagnostics: [diagnostic('verifier_error', message, retryable)],
        };
      }
    };

    const result = work();
    return {
      attemptId: request.correlation.attemptId ?? ('att_verifier' as AttemptId),
      cancel: async () => controller.abort(),
      result: () => result,
    };
  }
}

function verificationEnvelope(request: ExecutionRequest, candidate: EvidenceEnvelope, outcome: VerificationOutcome): EvidenceEnvelope {
  const byId = new Map(candidate.claims.map((c) => [c.id, c]));
  const claims: Claim[] = outcome.claimVerdicts.map((v) => ({
    id: v.claimId,
    statement: byId.get(v.claimId)?.statement ?? '',
    confidence: v.verdict === 'inconclusive' ? 0.5 : 1,
    assumptions: [],
    dependencies: [],
    status: v.verdict === 'verified' ? 'verified' : v.verdict === 'refuted' ? 'refuted' : 'proposed',
  }));
  claims.push({
    id: VERIFICATION_CLAIM_ID,
    statement: outcome.outcome,
    confidence: 1,
    assumptions: [],
    dependencies: [],
    status: outcome.outcome === 'verified' ? 'verified' : outcome.outcome === 'refuted' ? 'refuted' : 'proposed',
  });
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    correlation: request.correlation,
    tier: 2,
    taskScope: 'verification',
    claims,
    evidence: [{ kind: 'test-result', summary: (outcome.detail ?? outcome.outcome).slice(0, 2000) }],
    redactionApplied: false,
  };
}

/** Reads a verifier attempt's overall outcome and per-claim verdicts back from its envelope. */
export function readVerification(envelope: EvidenceEnvelope | undefined): VerificationOutcome | undefined {
  const summary = envelope?.claims.find((c) => c.id === VERIFICATION_CLAIM_ID);
  if (envelope === undefined || summary === undefined) return undefined;
  const outcome = summary.statement === 'verified' || summary.statement === 'refuted' ? summary.statement : 'inconclusive';
  return {
    outcome,
    claimVerdicts: envelope.claims
      .filter((c) => c.id !== VERIFICATION_CLAIM_ID)
      .map((c) => ({ claimId: c.id, verdict: c.status === 'verified' ? 'verified' : c.status === 'refuted' ? 'refuted' : 'inconclusive' })),
    ...(envelope.evidence[0] === undefined ? {} : { detail: envelope.evidence[0].summary }),
  };
}
