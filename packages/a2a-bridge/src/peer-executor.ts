import { randomBytes } from 'node:crypto';
import {
  type AttemptId,
  CancelledError,
  type Clock,
  diagnostic,
  type Diagnostic,
  digestOf,
  type ExecutionHandle,
  type ExecutionObserver,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type Logger,
  type MetricsSink,
  NOOP_OBSERVER,
  noopLogger,
  noopMetrics,
  type NormalizedExecutionResult,
  type OutboxRecord,
  type OutboxRepository,
  type PreparedSubmission,
  type ResumeRef,
  type SecretProvider,
  sleep,
  systemClock,
  type TerminalStatus,
  toDiagnostic,
  traceparent,
} from '@dvo/core';
import { Redactor } from '@dvo/evidence';
import type { z } from 'zod';
import type { AgentCardResolver, PeerProfile } from './card-resolver.ts';
import type { PeerConfig } from './config.ts';
import { A2aHttpError, A2aRpcError, A2aTransportError } from './errors.ts';
import { buildSendMessageParams, extractOutput, peerFailureDiagnostic, type SendMessageParams, terminalStatusOf } from './mapping.ts';
import { JsonRpcHttpTransport } from './transport.ts';
import {
  INTERRUPTED_TASK_STATES,
  type Message,
  SendMessageResponseSchema,
  stateRank,
  type Task,
  TaskSchema,
  TERMINAL_TASK_STATES,
} from './wire.ts';

/** What the outbox stores for an A2A submission: exactly what will be sent, and where. */
export interface A2aOutboxPayload {
  rpcUrl: string;
  params: SendMessageParams;
  extensions: string[];
  cardDigest: string;
}

export interface A2aPeerExecutorDeps {
  resolver: AgentCardResolver;
  ledger: OutboxRepository;
  secrets?: SecretProvider;
  clock?: Clock;
  logger?: Logger;
  metrics?: MetricsSink;
  fetch?: typeof fetch;
  redactor?: Redactor;
  /** Where inline (`raw`) artifact bytes are parked; nothing there is ever executed. */
  quarantine?: { put(bytes: Uint8Array): Promise<{ sha256: string; path: string }> };
  random?: () => number;
  /** Send retries for provably-unsent requests (and resends to de-duplicating peers). */
  maxSendAttempts?: number;
  /** Consecutive failed polls before the peer is declared unreachable. */
  maxPollFailures?: number;
}

interface RunState {
  cancelRequested: boolean;
  cancelReason: string;
  wake: AbortController;
}

/**
 * One allowlisted A2A peer as an Executor (design §9). MVP semantics: single hop, read-only,
 * polling only (even if the peer supports streaming), transactional outbox for submission,
 * conservative handling of unknown delivery, monotonic observation of remote state.
 */
export class A2aPeerExecutor implements Executor {
  readonly id: string;
  readonly kind = 'a2a-peer' as const;
  readonly peer: PeerConfig;
  readonly #deps: Required<Pick<A2aPeerExecutorDeps, 'clock' | 'logger' | 'metrics' | 'redactor' | 'random'>> & A2aPeerExecutorDeps;
  readonly #transport: JsonRpcHttpTransport;

  constructor(peer: PeerConfig, deps: A2aPeerExecutorDeps) {
    this.peer = peer;
    this.id = peer.id;
    this.#deps = {
      ...deps,
      clock: deps.clock ?? systemClock,
      logger: (deps.logger ?? noopLogger).child({ peerId: peer.id }),
      metrics: deps.metrics ?? noopMetrics,
      redactor: deps.redactor ?? new Redactor(),
      random: deps.random ?? Math.random,
    };
    this.#transport = new JsonRpcHttpTransport({
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      clock: this.#deps.clock,
      requestTimeoutMs: peer.requestTimeoutMs,
      maxResponseBytes: Math.max(1024 * 1024, peer.maxArtifactBytes * 2),
      metrics: this.#deps.metrics,
      peerLabel: peer.id,
    });
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    try {
      const profile = await this.#deps.resolver.resolve(this.peer);
      return {
        kind: 'a2a-peer',
        skills: this.#callableSkills(profile),
        maxEvidenceTier: profile.supportsEvidenceExtension ? 2 : 0,
        supportsCancel: true,
        supportsResume: true,
        supportsIdempotentResubmit: this.peer.dedupSupported,
        available: true,
        runtime: { name: `a2a:${profile.card.name}`, version: profile.card.version, profileDigest: profile.cardDigest },
      };
    } catch (error) {
      return {
        kind: 'a2a-peer',
        skills: [],
        maxEvidenceTier: 0,
        supportsCancel: false,
        supportsResume: true,
        supportsIdempotentResubmit: this.peer.dedupSupported,
        available: false,
        degradedReason: toDiagnostic(error).safeMessage,
      };
    }
  }

  /** Card-declared skills intersected with the configured allowlist (empty allowlist = all declared). */
  #callableSkills(profile: PeerProfile): string[] {
    if (this.peer.allowedSkills.length === 0) return profile.declaredSkills;
    return profile.declaredSkills.filter((s) => this.peer.allowedSkills.includes(s));
  }

  async prepare(request: ExecutionRequest): Promise<PreparedSubmission> {
    const profile = await this.#deps.resolver.resolve(this.peer);
    if (request.skill !== undefined && !this.#callableSkills(profile).includes(request.skill)) {
      throw new A2aHttpError(403, `skill ${request.skill} not callable on ${this.peer.id}`);
    }
    const params = buildSendMessageParams(request, profile);
    const payload: A2aOutboxPayload = {
      rpcUrl: profile.rpcUrl,
      params,
      extensions: profile.activeExtensions,
      cardDigest: profile.cardDigest,
    };
    return { payload, requestDigest: digestOf(params) };
  }

  async start(request: ExecutionRequest, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    return this.#handle(request, observer);
  }

  async resume(ref: ResumeRef, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    return this.#handle(ref.request, observer);
  }

  #handle(request: ExecutionRequest, observer: ExecutionObserver): ExecutionHandle {
    const attemptId = request.correlation.attemptId ?? ('att_unknown' as AttemptId);
    const run: RunState = { cancelRequested: false, cancelReason: 'cancelled', wake: new AbortController() };
    const startedAt = this.#deps.clock.now();
    const result = this.#execute(request, observer, run, startedAt).catch((error: unknown) => {
      this.#deps.logger.error({ attemptId, error: toDiagnostic(error) }, 'peer attempt failed unexpectedly');
      const d = toDiagnostic(error, 'peer_executor_error');
      return this.#result(request, startedAt, 'failed', [diagnostic(d.code, d.safeMessage, d.retryable)]);
    });
    return {
      attemptId,
      cancel: async (reason = 'cancelled') => {
        run.cancelRequested = true;
        run.cancelReason = reason;
        run.wake.abort(new CancelledError(reason));
      },
      result: () => result,
    };
  }

  async #execute(
    request: ExecutionRequest,
    observer: ExecutionObserver,
    run: RunState,
    startedAt: number,
  ): Promise<NormalizedExecutionResult> {
    const attemptId = request.correlation.attemptId;
    if (attemptId === undefined)
      return this.#result(request, startedAt, 'failed', [diagnostic('attempt_id_missing', 'request has no attempt id')]);
    let record = await this.#deps.ledger.getOutbox(attemptId);
    if (record === undefined)
      return this.#result(request, startedAt, 'failed', [diagnostic('outbox_missing', 'no outbox record for this attempt')]);
    const payload = record.payload as A2aOutboxPayload;

    if (record.state === 'abandoned')
      return this.#result(request, startedAt, 'failed', [diagnostic('submission_abandoned', 'submission was abandoned')]);
    if (record.state === 'sending') {
      // Found mid-send (crash or restart): delivery is unknowable from here.
      record = await this.#deps.ledger.transitionOutbox(attemptId, 'sending', 'submission_unknown', {
        lastError: 'interrupted while sending',
      });
      observer.onProgress({ kind: 'submission_unknown', reason: 'interrupted while sending' });
      this.#deps.metrics.inc('dvo_peer_submission_unknown_total', { peer: this.peer.id });
    }

    let task: Task | undefined;
    let directMessage: Message | undefined;
    if (record.state === 'submitted') {
      if (record.remoteTaskId === undefined || record.remoteTaskId.startsWith('message:')) {
        return this.#result(request, startedAt, 'failed', [diagnostic('remote_task_lost', 'submitted without a pollable remote task')]);
      }
      const fetched = await this.#getTask(payload, record.remoteTaskId, request);
      if (fetched.kind === 'lost')
        return this.#result(
          request,
          startedAt,
          'failed',
          [diagnostic('remote_task_lost', 'peer no longer knows the task')],
          record.remoteTaskId,
        );
      task = fetched.kind === 'ok' ? fetched.task : undefined;
      record = { ...record };
    } else {
      const sent = await this.#send(request, record, payload, observer);
      if (sent.kind === 'failed') return this.#result(request, startedAt, 'failed', [sent.diagnostic]);
      record = sent.record;
      task = sent.task;
      directMessage = sent.message;
    }

    if (directMessage !== undefined) {
      return this.#fromMessage(request, startedAt, directMessage);
    }
    const remoteTaskId = record.remoteTaskId!;
    return this.#poll(request, observer, run, startedAt, payload, remoteTaskId, task);
  }

  async #send(
    request: ExecutionRequest,
    initial: OutboxRecord,
    payload: A2aOutboxPayload,
    observer: ExecutionObserver,
  ): Promise<{ kind: 'ok'; record: OutboxRecord; task?: Task; message?: Message } | { kind: 'failed'; diagnostic: Diagnostic }> {
    const ledger = this.#deps.ledger;
    const attemptId = initial.attemptId;
    const maxAttempts = this.#deps.maxSendAttempts ?? 3;
    let state = initial.state;
    if (state === 'submission_unknown' && !this.peer.dedupSupported) {
      return {
        kind: 'failed',
        diagnostic: diagnostic('submission_unknown', 'delivery unknown and the peer does not de-duplicate; not resending'),
      };
    }
    for (let attempt = 1; ; attempt++) {
      await ledger.transitionOutbox(attemptId, state, 'sending', { incrementSendCount: true });
      try {
        const response = await this.#transport.call(payload.rpcUrl, 'SendMessage', payload.params, SendMessageResponseSchema, {
          headers: await this.#headers(request, payload.extensions),
        });
        if (response.task !== undefined) {
          const record = await ledger.transitionOutbox(attemptId, 'sending', 'submitted', { remoteTaskId: response.task.id });
          observer.onProgress({ kind: 'remote_submitted', remoteTaskId: response.task.id, requestDigest: initial.requestDigest });
          return { kind: 'ok', record, task: response.task };
        }
        const record = await ledger.transitionOutbox(attemptId, 'sending', 'submitted', {
          remoteTaskId: `message:${response.message!.messageId}`,
        });
        observer.onProgress({
          kind: 'remote_submitted',
          remoteTaskId: `message:${response.message!.messageId}`,
          requestDigest: initial.requestDigest,
        });
        return { kind: 'ok', record, message: response.message! };
      } catch (error) {
        const safe = this.#deps.redactor.redactText(toDiagnostic(error).safeMessage).value;
        if (error instanceof A2aTransportError && error.phase === 'not_sent') {
          await ledger.transitionOutbox(attemptId, 'sending', 'pending', { lastError: safe });
          state = 'pending';
          if (attempt < maxAttempts) {
            this.#deps.metrics.inc('dvo_retries_total', { operation: 'a2a_send_not_sent' });
            await sleep(this.#deps.clock, this.#backoff(attempt));
            continue;
          }
          await ledger.transitionOutbox(attemptId, 'pending', 'abandoned', { lastError: safe });
          return { kind: 'failed', diagnostic: diagnostic('peer_unreachable', 'peer unreachable; request was never delivered', true) };
        }
        if (error instanceof A2aTransportError) {
          await ledger.transitionOutbox(attemptId, 'sending', 'submission_unknown', { lastError: safe });
          state = 'submission_unknown';
          observer.onProgress({ kind: 'submission_unknown', reason: safe });
          this.#deps.metrics.inc('dvo_peer_submission_unknown_total', { peer: this.peer.id });
          if (this.peer.dedupSupported && attempt < maxAttempts) {
            // Same messageId: a de-duplicating peer recognises the resend (design §10.2).
            this.#deps.metrics.inc('dvo_retries_total', { operation: 'a2a_send_dedup_resend' });
            await sleep(this.#deps.clock, this.#backoff(attempt));
            continue;
          }
          return {
            kind: 'failed',
            diagnostic: diagnostic('submission_unknown', 'delivery of the request could not be confirmed; not resending'),
          };
        }
        await ledger.transitionOutbox(attemptId, 'sending', 'abandoned', { lastError: safe });
        const d = toDiagnostic(error, 'peer_rejected');
        return { kind: 'failed', diagnostic: diagnostic(d.code, d.safeMessage, d.retryable) };
      }
    }
  }

  async #poll(
    request: ExecutionRequest,
    observer: ExecutionObserver,
    run: RunState,
    startedAt: number,
    payload: A2aOutboxPayload,
    remoteTaskId: string,
    first: Task | undefined,
  ): Promise<NormalizedExecutionResult> {
    const seen = new Set<string>();
    let last: Task | undefined;
    const observe = (task: Task): Task => {
      // Order first: a regression is audited even when it repeats an earlier snapshot.
      if (last !== undefined && stateRank(task.status.state) < stateRank(last.status.state)) {
        observer.onProgress({ kind: 'observation_ignored', reason: `out-of-order ${task.status.state} after ${last.status.state}` });
        return last;
      }
      if (last !== undefined && TERMINAL_TASK_STATES.has(last.status.state)) {
        observer.onProgress({ kind: 'observation_ignored', reason: `terminal state is irreversible (${last.status.state})` });
        return last;
      }
      // Then de-duplicate by (attempt, remote task, observation digest) (design §10.2).
      const digest = digestOf({ state: task.status.state, artifacts: task.artifacts ?? [] });
      if (seen.has(digest)) return last ?? task;
      seen.add(digest);
      last = task;
      observer.onProgress({ kind: 'remote_state', state: task.status.state });
      return task;
    };

    let current = first === undefined ? undefined : observe(first);
    let delay = this.peer.poll.initialDelayMs;
    let failures = 0;
    for (;;) {
      if (current !== undefined && TERMINAL_TASK_STATES.has(current.status.state)) {
        return this.#fromTask(request, startedAt, current, run.cancelRequested);
      }
      if (current !== undefined && INTERRUPTED_TASK_STATES.has(current.status.state)) {
        await this.#bestEffortCancel(payload, remoteTaskId, request);
        return this.#result(request, startedAt, 'failed', [peerFailureDiagnostic(current, 'peer_interrupted')], remoteTaskId);
      }
      if (run.cancelRequested) return this.#cancelRemote(request, startedAt, payload, remoteTaskId, run.cancelReason);
      try {
        await sleep(this.#deps.clock, delay, run.wake.signal);
      } catch {
        continue; // woken by cancel: loop re-checks run.cancelRequested
      }
      delay = Math.min(this.peer.poll.maxDelayMs, delay * this.peer.poll.multiplier) * (0.8 + 0.4 * this.#deps.random());
      const fetched = await this.#getTask(payload, remoteTaskId, request);
      if (fetched.kind === 'lost') {
        return this.#result(request, startedAt, 'failed', [diagnostic('remote_task_lost', 'peer no longer knows the task')], remoteTaskId);
      }
      if (fetched.kind === 'error') {
        failures += 1;
        if (failures >= (this.#deps.maxPollFailures ?? 10)) {
          return this.#result(
            request,
            startedAt,
            'failed',
            [diagnostic('peer_unreachable', 'peer stopped answering status queries', true)],
            remoteTaskId,
          );
        }
        continue;
      }
      failures = 0;
      current = observe(fetched.task);
    }
  }

  async #getTask(
    payload: A2aOutboxPayload,
    remoteTaskId: string,
    request: ExecutionRequest,
  ): Promise<{ kind: 'ok'; task: Task } | { kind: 'lost' } | { kind: 'error' }> {
    try {
      const task = await this.#transport.call(payload.rpcUrl, 'GetTask', { id: remoteTaskId, historyLength: 0 }, TaskSchema, {
        headers: await this.#headers(request, payload.extensions),
      });
      if (task.id !== remoteTaskId) return { kind: 'error' };
      return { kind: 'ok', task };
    } catch (error) {
      if (error instanceof A2aRpcError && error.a2aType === 'TaskNotFoundError') return { kind: 'lost' };
      return { kind: 'error' };
    }
  }

  async #bestEffortCancel(payload: A2aOutboxPayload, remoteTaskId: string, request: ExecutionRequest): Promise<void> {
    try {
      await this.#transport.call(payload.rpcUrl, 'CancelTask', { id: remoteTaskId }, TaskSchema, {
        headers: await this.#headers(request, payload.extensions),
      });
    } catch {
      // Best effort only.
    }
  }

  /**
   * Cancellation is best effort (invariant 3). If the peer finished before the cancel took
   * effect, the completed result is returned flagged `afterCancel` so the engine can decide
   * (and audit) whether to accept it as a late result.
   */
  async #cancelRemote(
    request: ExecutionRequest,
    startedAt: number,
    payload: A2aOutboxPayload,
    remoteTaskId: string,
    reason: string,
  ): Promise<NormalizedExecutionResult> {
    const headers = await this.#headers(request, payload.extensions);
    try {
      const task = await this.#transport.call(payload.rpcUrl, 'CancelTask', { id: remoteTaskId }, TaskSchema, { headers });
      if (task.status.state === 'TASK_STATE_COMPLETED') return this.#fromTask(request, startedAt, task, true);
      return this.#result(request, startedAt, 'cancelled', [diagnostic('cancelled', `cancelled: ${reason}`)], remoteTaskId);
    } catch (error) {
      const notCancelable = error instanceof A2aRpcError && error.a2aType === 'TaskNotCancelableError';
      const unsupported =
        error instanceof A2aRpcError && (error.a2aType === 'UnsupportedOperationError' || error.a2aType === 'MethodNotFoundError');
      if (notCancelable) {
        const final = await this.#getTask(payload, remoteTaskId, request);
        if (final.kind === 'ok' && TERMINAL_TASK_STATES.has(final.task.status.state))
          return this.#fromTask(request, startedAt, final.task, true);
      }
      const code = unsupported ? 'cancel_unsupported' : notCancelable ? 'cancel_not_cancelable' : 'cancel_unconfirmed';
      return this.#result(
        request,
        startedAt,
        'cancelled',
        [diagnostic(code, `cancel requested (${reason}); peer did not confirm`)],
        remoteTaskId,
      );
    }
  }

  async #fromTask(request: ExecutionRequest, startedAt: number, task: Task, afterCancel: boolean): Promise<NormalizedExecutionResult> {
    const status = terminalStatusOf(task.status.state) ?? 'failed';
    if (status !== 'completed') {
      const code = status === 'refused' ? 'peer_rejected' : status === 'cancelled' ? 'peer_cancelled' : 'peer_failed';
      return this.#result(request, startedAt, status, [peerFailureDiagnostic(task, code)], task.id);
    }
    const extracted = extractOutput(task, request, { maxRawBytes: this.peer.maxArtifactBytes });
    for (const raw of extracted.rawArtifacts) await this.#deps.quarantine?.put(raw.bytes);
    if (extracted.envelope === undefined) {
      return this.#result(
        request,
        startedAt,
        'invalid_output',
        [diagnostic('peer_output_invalid', `peer output unusable: ${extracted.issues.slice(0, 3).join('; ')}`)],
        task.id,
      );
    }
    const diagnostics = extracted.synthesized
      ? [diagnostic('tier0_fallback', 'peer returned plain content; synthesized a tier-0 envelope')]
      : [];
    return {
      ...this.#result(request, startedAt, 'completed', diagnostics, task.id),
      output: extracted.envelope,
      ...(afterCancel ? { afterCancel: true } : {}),
    };
  }

  #fromMessage(request: ExecutionRequest, startedAt: number, message: Message): Promise<NormalizedExecutionResult> {
    const pseudoTask: Task = {
      id: `message:${message.messageId}`,
      status: { state: 'TASK_STATE_COMPLETED', message },
      artifacts: message.parts.some((p) => p.data !== undefined)
        ? [{ artifactId: 'message', parts: message.parts, ...(message.extensions === undefined ? {} : { extensions: message.extensions }) }]
        : [],
    };
    return this.#fromTask(request, startedAt, pseudoTask, false);
  }

  #result(
    request: ExecutionRequest,
    startedAt: number,
    status: TerminalStatus,
    diagnostics: Diagnostic[],
    remoteTaskId?: string,
  ): NormalizedExecutionResult {
    return {
      correlation: request.correlation,
      executorId: this.id,
      terminalStatus: status,
      usage: { elapsedMs: this.#deps.clock.now() - startedAt, costUsd: this.peer.costPerCallUsd },
      diagnostics: diagnostics.map((d) => ({ ...d, safeMessage: this.#deps.redactor.redactText(d.safeMessage).value })),
      ...(remoteTaskId === undefined ? {} : { remoteTaskId }),
    };
  }

  async #headers(request: ExecutionRequest, extensions: readonly string[]): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      traceparent: traceparent(request.correlation.traceId, randomBytes(8).toString('hex')),
    };
    if (extensions.length > 0) headers['a2a-extensions'] = extensions.join(',');
    if (this.peer.authScheme !== 'none' && this.peer.credentialsRef !== undefined) {
      if (this.#deps.secrets === undefined) throw new A2aHttpError(401, 'credentials');
      const secret = (await this.#deps.secrets.resolve(this.peer.credentialsRef)).reveal();
      if (this.peer.authScheme === 'bearer') headers['authorization'] = `Bearer ${secret}`;
      else headers[this.peer.apiKeyHeader.toLowerCase()] = secret;
    }
    return headers;
  }

  #backoff(attempt: number): number {
    const base = this.peer.poll.initialDelayMs * 2 ** (attempt - 1);
    return Math.min(this.peer.poll.maxDelayMs, base) * this.#deps.random();
  }
}

/** Zod schema re-exported for tests that fabricate peer responses. */
export const A2aTaskSchema: z.ZodType<Task> = TaskSchema;
