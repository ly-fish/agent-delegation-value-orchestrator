import {
  type ActionKind,
  applyEvent,
  type AttemptId,
  type AttemptResultSummary,
  type AttemptState,
  attemptPath,
  type AttemptStatus,
  attemptsOf,
  canTransitionTask,
  type Clock,
  type Correlation,
  type DataClassification,
  type DecisionMadeEvent,
  type DecisionRecord,
  diagnostic,
  type Diagnostic,
  type DomainEvent,
  type DomainEventType,
  EVENT_SCHEMA_VERSION,
  type EventOfType,
  type EventPayload,
  type EvidenceEnvelope,
  type EvidenceTier,
  type ExecutionProgress,
  type ExecutionRequest,
  type Executor,
  type ExecutorKind,
  fromIso,
  HarnessError,
  type HarnessStore,
  type IdGenerator,
  isCandidateResult,
  isOverBudget,
  isTerminalAttemptStatus,
  isTerminalPhase,
  type Logger,
  type MetricsSink,
  noopLogger,
  noopMetrics,
  type NormalizedExecutionResult,
  type OutboxRecord,
  type PeerId,
  type PolicyEngine,
  primaryClaim,
  type ResumeRef,
  type StopReason,
  type TaskId,
  type TaskPhase,
  type TaskSpec,
  type TaskState,
  toDiagnostic,
  toIso,
} from '@dvo/core';
import { type ArtifactPolicy, DEFAULT_ARTIFACT_POLICY, EgressGuard, EvidenceGateway, type Redactor } from '@dvo/evidence';
import type { AttemptScheduler, CircuitRegistry } from '@dvo/scheduler';
import { readVerification } from '@dvo/verifier';
import { TaskActor } from './actor.ts';
import { CapabilityCache, type ExecutorCatalog, findPeer, type PeerDescriptor } from './catalog.ts';
import { finalOutcome, type FinalizeReason } from './finalizer.ts';
import { type IngressLimits, type SubmitOptions, type SubmitResult, TaskIngress } from './ingress.ts';
import { localPrompt, peerPrompt } from './prompts.ts';
import type { ReliabilityTracker } from './reliability.ts';
import { buildPolicyInput, skillOf } from './snapshot.ts';

export interface EngineConfig {
  /** Accept a valid result that arrives after its attempt was cancelled (design §10.1). */
  acceptLateResults: boolean;
  /** Safety valve against decision loops. */
  maxDecisions: number;
  verifierTimeoutMs: number;
  defaultSkill: string;
  /** Latency prior for executors without history, as a fraction of their timeout. */
  latencyPriorFraction: number;
  capabilityTtlMs: number;
  artifactPolicy: (peer: PeerDescriptor) => ArtifactPolicy;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  acceptLateResults: true,
  maxDecisions: 24,
  verifierTimeoutMs: 60_000,
  defaultSkill: 'general',
  latencyPriorFraction: 0.5,
  capabilityTtlMs: 30_000,
  artifactPolicy: () => DEFAULT_ARTIFACT_POLICY,
};

export interface EngineDeps {
  store: HarnessStore;
  policy: PolicyEngine;
  scheduler: AttemptScheduler;
  catalog: ExecutorCatalog;
  circuits: CircuitRegistry;
  reliability: ReliabilityTracker;
  redactor: Redactor;
  clock: Clock;
  ids: IdGenerator;
  logger?: Logger;
  metrics?: MetricsSink;
  ingressLimits?: IngressLimits;
  config?: Partial<EngineConfig>;
}

interface LaunchPlan {
  executor: Executor;
  kind: ExecutorKind;
  purpose: Exclude<ActionKind, 'stop'>;
  peer?: PeerDescriptor;
  tier: EvidenceTier;
  prompt: string;
  evidence?: EvidenceEnvelope;
  classificationSent: DataClassification;
  reservedCostUsd: number;
  reservedRemoteCalls: number;
  timeoutMs: number;
  targets?: AttemptId[];
  failure?: Diagnostic;
}

export interface RecoveryReport {
  tasks: number;
  resumed: number;
  failed: number;
  durationMs: number;
}

/**
 * The control loop (design §4): ingress → policy decision → scheduler → executors →
 * evidence gateway → verifier → finalizer, all persisted as an append-only event log.
 *
 * The policy is consulted whenever nothing is in flight. While attempts are in flight it
 * is consulted only for verification (a result arrived and a verifier is free) and early
 * stopping (something is verified); any other choice is discarded unrecorded and the task
 * waits, so in-flight escalations are never thrashed.
 */
export class OrchestrationEngine {
  readonly #deps: EngineDeps;
  readonly #config: EngineConfig;
  readonly #logger: Logger;
  readonly #metrics: MetricsSink;
  readonly #ingress: TaskIngress;
  readonly #gateway: EvidenceGateway;
  readonly #egress: EgressGuard;
  readonly #capabilities: CapabilityCache;
  readonly #actors = new Map<TaskId, TaskActor>();
  readonly #waiters = new Map<TaskId, Array<(state: TaskState) => void>>();
  #accepting = true;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#config = { ...DEFAULT_ENGINE_CONFIG, ...deps.config };
    this.#logger = deps.logger ?? noopLogger;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#gateway = new EvidenceGateway(deps.redactor);
    this.#egress = new EgressGuard(deps.redactor);
    this.#capabilities = new CapabilityCache(deps.clock, this.#config.capabilityTtlMs);
    this.#ingress = new TaskIngress({
      store: deps.store,
      ids: deps.ids,
      clock: deps.clock,
      redactor: deps.redactor,
      ...(deps.ingressLimits === undefined ? {} : { limits: deps.ingressLimits }),
      knownVerifier: (id) => deps.catalog.verifiers.has(id),
    });
  }

  get capabilities(): CapabilityCache {
    return this.#capabilities;
  }

  // ─── public API ───────────────────────────────────────────────────────────────

  async submit(spec: TaskSpec, options: SubmitOptions = {}): Promise<SubmitResult> {
    if (!this.#accepting) throw new HarnessError('runtime_unavailable', 'engine is shutting down', { retryable: true });
    const result = await this.#ingress.submit(spec, options);
    await this.start(result.taskId);
    return result;
  }

  /** Ensures a live actor drives the task (no-op for terminal or already-running tasks). */
  async start(taskId: TaskId): Promise<void> {
    if (this.#actors.has(taskId)) return;
    const state = await this.#deps.store.load(taskId);
    if (state === undefined || isTerminalPhase(state.phase)) return;
    const actor = this.#actor(state);
    void actor.enqueue(() => this.#step(actor));
  }

  async get(taskId: TaskId): Promise<TaskState | undefined> {
    return this.#actors.get(taskId)?.state ?? (await this.#deps.store.load(taskId));
  }

  async cancel(taskId: TaskId, reason: string, requestedBy: string): Promise<TaskState | undefined> {
    let actor = this.#actors.get(taskId);
    if (actor === undefined) {
      const state = await this.#deps.store.load(taskId);
      if (state === undefined) return undefined;
      if (isTerminalPhase(state.phase)) return state;
      actor = this.#actor(state);
    }
    const a = actor;
    await a.enqueue(async () => {
      if (isTerminalPhase(a.state.phase) || a.state.cancelRequested) return;
      const safeReason = this.#deps.redactor.redactText(reason.slice(0, 200)).value;
      await this.#commit(a, [this.#event(a, 'task.cancel_requested', { reason: safeReason, requestedBy: requestedBy.slice(0, 100) })]);
      a.pendingStop = { reason: 'cancelled', detail: `cancelled: ${safeReason}` };
      await this.#syncPhase(a, 'cancel requested');
      await this.#cancelActive(a, 'task cancelled');
      if (a.state.activeAttempts.length === 0) await this.#finalize(a);
    });
    return a.state;
  }

  /** Human approval for delegating restricted data (design §12.2). */
  async approve(taskId: TaskId, approver: string, reason: string): Promise<TaskState | undefined> {
    const actor = this.#actors.get(taskId);
    if (actor === undefined) return this.#deps.store.load(taskId);
    await actor.enqueue(async () => {
      if (isTerminalPhase(actor.state.phase) || actor.state.approvals.restrictedDelegation) return;
      await this.#commit(actor, [
        this.#event(actor, 'task.approval_granted', {
          scope: 'restricted_delegation',
          approver: approver.slice(0, 100),
          reason: this.#deps.redactor.redactText(reason.slice(0, 500)).value,
        }),
      ]);
      await this.#step(actor);
    });
    return actor.state;
  }

  /** Resolves with the final state once the task is terminal. */
  waitForTerminal(taskId: TaskId): Promise<TaskState> {
    return new Promise((resolve, reject) => {
      // Register first, then check: a task finalised in between still resolves the waiter.
      let settled = false;
      const done = (state: TaskState): void => {
        if (settled) return;
        settled = true;
        resolve(state);
      };
      this.#waiters.set(taskId, [...(this.#waiters.get(taskId) ?? []), done]);
      void this.get(taskId).then((state) => {
        if (state === undefined) {
          settled = true;
          reject(new HarnessError('not_found', 'task not found'));
        } else if (isTerminalPhase(state.phase) && state.outcome !== undefined) {
          done(state);
        }
      }, reject);
    });
  }

  /** Waits until every live actor has drained its mailbox (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.#actors.values()].map((a) => a.idle()));
  }

  get activeTasks(): number {
    return this.#actors.size;
  }

  /**
   * Restart recovery (design §10.2): re-attach remote attempts through their outbox record
   * (never resending an unknown submission to a non-de-duplicating peer), fail orphaned local
   * and verifier attempts so the policy can retry with a *new* attempt, then resume each task.
   */
  async recover(): Promise<RecoveryReport> {
    const started = this.#deps.clock.now();
    await this.#deps.reliability.refresh();
    const report: RecoveryReport = { tasks: 0, resumed: 0, failed: 0, durationMs: 0 };
    for (const summary of await this.#deps.store.listTasks({ nonTerminal: true })) {
      if (this.#actors.has(summary.taskId)) continue;
      const state = await this.#deps.store.load(summary.taskId);
      if (state === undefined || isTerminalPhase(state.phase)) continue;
      report.tasks += 1;
      const actor = this.#actor(state);
      await actor.enqueue(async () => {
        for (const attemptId of [...actor.state.activeAttempts]) {
          const attempt = actor.state.attempts[attemptId]!;
          const resumed = await this.#recoverAttempt(actor, attempt);
          if (resumed) report.resumed += 1;
          else report.failed += 1;
        }
        if (actor.state.cancelRequested) actor.pendingStop = { reason: 'cancelled', detail: 'cancelled before restart' };
        await this.#step(actor);
      });
    }
    report.durationMs = this.#deps.clock.now() - started;
    this.#metrics.observe('dvo_recovery_duration_seconds', report.durationMs / 1000);
    this.#logger.info({ ...report }, 'recovery complete');
    return report;
  }

  /** Stops accepting tasks; optionally cancels in-flight attempts, then drains mailboxes. */
  async shutdown(options: { cancelActive: boolean } = { cancelActive: false }): Promise<void> {
    this.#accepting = false;
    for (const actor of this.#actors.values()) {
      actor.dispose();
      if (options.cancelActive) for (const managed of actor.running.values()) managed.cancel('shutdown');
    }
    if (options.cancelActive) await this.#deps.scheduler.drain();
    await this.idle();
  }

  // ─── control loop ─────────────────────────────────────────────────────────────

  #actor(state: TaskState): TaskActor {
    const existing = this.#actors.get(state.taskId);
    if (existing !== undefined) return existing;
    const actor = new TaskActor(state, this.#logger, (error) => this.#onActorError(state.taskId, error));
    this.#actors.set(state.taskId, actor);
    const delay = fromIso(state.budget.deadlineAt) - this.#deps.clock.now();
    actor.deadlineTimer = this.#deps.clock.setTimer(Math.max(0, delay), () => {
      void actor.enqueue(() => this.#onDeadline(actor));
    });
    return actor;
  }

  #onActorError(taskId: TaskId, error: unknown): void {
    this.#metrics.inc('dvo_transitions_rejected_total', { entity: 'actor_error' });
    this.#logger.error({ taskId, error: toDiagnostic(error) }, 'task processing error');
  }

  async #step(actor: TaskActor): Promise<void> {
    const state = actor.state;
    if (isTerminalPhase(state.phase)) return;
    if (state.phase === 'created') await this.#setPhase(actor, 'assessing', 'task accepted');
    if (actor.pendingStop !== undefined) {
      if (actor.state.activeAttempts.length === 0) await this.#finalize(actor);
      return;
    }
    const inFlight = actor.state.activeAttempts.length > 0;
    if (inFlight && !this.#worthConsultingWhileBusy(actor)) return;
    if (actor.state.decisionCount >= this.#config.maxDecisions) {
      await this.#stop(actor, 'budget', `decision limit (${this.#config.maxDecisions}) reached`);
      return;
    }

    const input = await buildPolicyInput(actor.state, this.#deps.clock.now(), {
      catalog: this.#deps.catalog,
      capabilities: this.#capabilities,
      circuits: this.#deps.circuits,
      reliability: this.#deps.reliability,
      defaultSkill: this.#config.defaultSkill,
      latencyPriorFraction: this.#config.latencyPriorFraction,
    });
    input.verifiers = input.verifiers.map((v) => (actor.failedVerifiers.has(v.id) ? { ...v, available: false } : v));
    const decision = this.#deps.policy.decide(input);
    const selected = decision.selected;
    const hasVerified = attemptsOf(actor.state).some((a) => isCandidateResult(a) && a.verification === 'verified');
    if (inFlight && selected.kind !== 'verify' && !(selected.kind === 'stop' && hasVerified)) return;

    const eventId = this.#deps.ids.eventId();
    const record: DecisionRecord = {
      taskId: actor.state.taskId,
      traceId: actor.state.traceId,
      eventId,
      idempotencyKey: `${actor.state.taskId}/decision/${input.decisionIndex}`,
      occurredAt: toIso(input.nowMs),
      stateRevision: actor.state.revision,
      decisionIndex: input.decisionIndex,
      candidateActions: decision.candidates,
      selected,
      policyVersion: this.#deps.policy.version,
      decisionReason: decision.reason,
      propensity: decision.propensity,
      explored: decision.explored,
      features: decision.features,
    };
    const decisionEvent = this.#event(actor, 'decision.made', { record, input }, { eventId });
    this.#metrics.inc('dvo_decisions_total', {
      action: selected.kind,
      explored: String(decision.explored),
      policy: this.#deps.policy.version,
    });
    for (const c of decision.candidates)
      for (const reason of c.blockedBy ?? []) this.#metrics.inc('dvo_decision_blocked_total', { action: c.action.kind, reason });

    switch (selected.kind) {
      case 'stop':
        await this.#commit(actor, [decisionEvent]);
        await this.#stop(actor, selected.reason, decision.reason);
        return;
      case 'continue_local':
        await this.#launch(actor, decisionEvent, [this.#localPlan(actor)]);
        return;
      case 'delegate':
        await this.#launch(actor, decisionEvent, [await this.#peerPlan(actor, selected.peerId, selected.evidenceTier, 'delegate')]);
        return;
      case 'parallel':
        await this.#launch(
          actor,
          decisionEvent,
          await Promise.all(selected.peerIds.map((p) => this.#peerPlan(actor, p, selected.evidenceTier, 'parallel'))),
        );
        return;
      case 'verify':
        await this.#launch(actor, decisionEvent, this.#verifyPlans(actor, selected.verifierId, selected.targetAttemptIds));
        return;
      case 'request_evidence': {
        const target = actor.state.attempts[selected.attemptId];
        const plan =
          target?.peerId === undefined
            ? this.#failedPlan('request_evidence', 'evidence_target_invalid', 'evidence request target is not a peer attempt')
            : await this.#peerPlan(actor, target.peerId, selected.nextTier, 'request_evidence', target.result?.output, selected.nextTier);
        await this.#launch(actor, decisionEvent, [plan]);
        return;
      }
    }
  }

  #worthConsultingWhileBusy(actor: TaskActor): boolean {
    const attempts = attemptsOf(actor.state);
    if (attempts.some((a) => isCandidateResult(a) && a.verification === 'verified')) return true;
    const verifierId = actor.state.verification?.verifierId;
    if (verifierId === undefined || actor.failedVerifiers.has(verifierId) || !this.#deps.catalog.verifiers.has(verifierId)) return false;
    const verifying = attempts.some((a) => a.executorKind === 'verifier' && !isTerminalAttemptStatus(a.status));
    return !verifying && attempts.some((a) => isCandidateResult(a) && a.verification === 'unverified');
  }

  async #stop(actor: TaskActor, reason: StopReason, detail: string): Promise<void> {
    actor.pendingStop = { reason, detail };
    if (actor.state.activeAttempts.length > 0) {
      await this.#cancelActive(actor, reason === 'sufficient_evidence' ? 'superseded' : reason);
      if (actor.state.activeAttempts.length > 0) return; // finalised once the cancelled attempts settle
    }
    await this.#finalize(actor);
  }

  async #onDeadline(actor: TaskActor): Promise<void> {
    if (isTerminalPhase(actor.state.phase) || actor.pendingStop !== undefined) return;
    await this.#stop(actor, 'deadline', 'task deadline reached');
  }

  async #cancelActive(actor: TaskActor, reason: string): Promise<void> {
    const events: DomainEvent[] = [];
    for (const attemptId of actor.state.activeAttempts) {
      const attempt = actor.state.attempts[attemptId]!;
      if (attempt.status === 'running' || attempt.status === 'awaiting_peer') {
        events.push(this.#event(actor, 'attempt.status_changed', { from: attempt.status, to: 'cancel_requested', reason }, { attemptId }));
      }
    }
    if (events.length > 0) await this.#commit(actor, events);
    for (const managed of actor.running.values()) managed.cancel(reason);
  }

  // ─── planning ─────────────────────────────────────────────────────────────────

  #failedPlan(purpose: LaunchPlan['purpose'], code: string, message: string): LaunchPlan {
    const local = this.#deps.catalog.local?.executor;
    const executor = local ?? this.#deps.catalog.peers[0]?.executor;
    if (executor === undefined) throw new HarnessError('internal', 'no executor configured');
    return {
      executor,
      kind: executor.kind,
      purpose,
      tier: 0,
      prompt: '',
      classificationSent: 'public',
      reservedCostUsd: 0,
      reservedRemoteCalls: 0,
      timeoutMs: 0,
      failure: diagnostic(code, message),
    };
  }

  #localPlan(actor: TaskActor): LaunchPlan {
    const local = this.#deps.catalog.local;
    if (local === undefined) return this.#failedPlan('continue_local', 'local_unavailable', 'no local executor configured');
    return {
      executor: local.executor,
      kind: 'dsh-local',
      purpose: 'continue_local',
      tier: 2,
      prompt: localPrompt(actor.state),
      classificationSent: actor.state.classification,
      reservedCostUsd: this.#deps.reliability.meanCost(local.executor.id) ?? local.costEstimateUsd,
      reservedRemoteCalls: 0,
      timeoutMs: local.timeoutMs,
    };
  }

  async #peerPlan(
    actor: TaskActor,
    peerId: PeerId,
    tier: EvidenceTier,
    purpose: LaunchPlan['purpose'],
    evidence?: EvidenceEnvelope,
    nextTier?: 1 | 2,
  ): Promise<LaunchPlan> {
    const peer = findPeer(this.#deps.catalog, peerId);
    if (peer === undefined) return this.#failedPlan(purpose, 'peer_not_configured', `peer ${peerId} is not configured`);
    const caps = await this.#capabilities.get(peer.executor);
    const egress = this.#egress.prepare(
      {
        classification: actor.state.classification,
        restrictedDelegationApproved: actor.state.approvals.restrictedDelegation,
        taskScope: actor.state.userGoal,
        ...(evidence === undefined ? {} : { evidence }),
        requestedTier: tier,
      },
      { peerId, trustTier: peer.trustTier, allowRestricted: peer.allowRestricted, maxEvidenceTier: caps.maxEvidenceTier },
    );
    const base = {
      executor: peer.executor,
      kind: 'a2a-peer' as const,
      purpose,
      peer,
      reservedCostUsd: this.#deps.reliability.meanCost(peer.executor.id) ?? peer.costPerCallUsd,
      reservedRemoteCalls: 1,
      timeoutMs: peer.timeoutMs,
    };
    if (!egress.allowed) {
      // The policy should never select this; refusing here is defence in depth.
      return {
        ...base,
        tier: 0,
        prompt: '',
        classificationSent: actor.state.classification,
        failure: diagnostic('unsafe_egress', `egress to ${peerId} refused: ${egress.reason}`),
      };
    }
    if (egress.redactionApplied) this.#metrics.inc('dvo_redactions_total', { where: 'egress' });
    return {
      ...base,
      tier: egress.tier,
      prompt: peerPrompt(egress.taskScope, nextTier),
      ...(egress.evidence === undefined ? {} : { evidence: egress.evidence }),
      classificationSent: egress.classificationSent,
    };
  }

  #verifyPlans(actor: TaskActor, verifierId: string, targets: readonly AttemptId[]): LaunchPlan[] {
    const executor = this.#deps.catalog.verifiers.executor(verifierId);
    if (executor === undefined) return [this.#failedPlan('verify', 'verifier_unavailable', `verifier ${verifierId} is not configured`)];
    const room = Math.max(1, actor.state.budget.maxParallelAttempts - actor.state.activeAttempts.length);
    return targets.slice(0, room).map((target) => ({
      executor,
      kind: 'verifier' as const,
      purpose: 'verify' as const,
      tier: 2 as const,
      prompt: '',
      classificationSent: actor.state.classification,
      reservedCostUsd: 0,
      reservedRemoteCalls: 0,
      timeoutMs: this.#config.verifierTimeoutMs,
      targets: [target],
    }));
  }

  // ─── launching ────────────────────────────────────────────────────────────────

  async #launch(actor: TaskActor, decisionEvent: DecisionMadeEvent, plans: LaunchPlan[]): Promise<void> {
    const state = actor.state;
    const now = this.#deps.clock.now();
    const taskDeadline = fromIso(state.budget.deadlineAt);
    const events: DomainEvent[] = [decisionEvent];
    const outbox: OutboxRecord[] = [];
    const starts: Array<{ attemptId: AttemptId; plan: LaunchPlan; request: ExecutionRequest; deadlineMs: number }> = [];
    // Only a failure of the executor itself (not a planning refusal) counts against its reliability.
    const executorFailures: AttemptId[] = [];

    for (const plan of plans) {
      const attemptId = this.#deps.ids.attemptId();
      const deadlineMs = Math.min(taskDeadline, now + plan.timeoutMs);
      const request = this.#request(state, attemptId, plan, deadlineMs, decisionEvent.eventId);
      let failure = plan.failure;
      let prepared: Awaited<ReturnType<NonNullable<Executor['prepare']>>> | undefined;
      if (failure === undefined && plan.executor.prepare !== undefined) {
        try {
          prepared = await plan.executor.prepare(request);
        } catch (error) {
          const d = toDiagnostic(error, 'prepare_failed');
          failure = diagnostic(d.code, d.safeMessage, d.retryable);
          executorFailures.push(attemptId);
          if (plan.peer !== undefined) this.#deps.circuits.get(plan.executor.id).onFailure('prepare_failed');
        }
      }
      events.push(
        this.#event(
          actor,
          'attempt.created',
          {
            executorId: plan.executor.id,
            executorKind: plan.kind,
            ...(plan.peer === undefined ? {} : { peerId: plan.peer.peerId }),
            purpose: plan.purpose,
            decisionIndex: decisionEvent.payload.record.decisionIndex,
            deadlineAt: toIso(deadlineMs),
            idempotencyKey: request.correlation.idempotencyKey,
            requestedTier: plan.tier,
            ...(request.skill === undefined ? {} : { skill: request.skill }),
            reservedCostUsd: failure === undefined ? plan.reservedCostUsd : 0,
            reservedRemoteCalls: failure === undefined ? plan.reservedRemoteCalls : 0,
            ...(plan.targets === undefined ? {} : { targetAttemptIds: plan.targets }),
            ...(prepared === undefined ? {} : { requestDigest: prepared.requestDigest }),
            classificationSent: plan.classificationSent,
          },
          { attemptId, parentEventId: decisionEvent.eventId },
        ),
      );
      if (failure !== undefined) {
        events.push(this.#event(actor, 'attempt.result_recorded', { result: this.#failureSummary(failure) }, { attemptId }));
        events.push(this.#event(actor, 'attempt.status_changed', { from: 'queued', to: 'failed', reason: failure.code }, { attemptId }));
        continue;
      }
      if (prepared !== undefined && plan.peer !== undefined) {
        outbox.push({
          attemptId,
          taskId: state.taskId,
          peerId: plan.peer.peerId,
          state: 'pending',
          requestDigest: prepared.requestDigest,
          idempotencyKey: request.correlation.idempotencyKey,
          payload: prepared.payload,
          sendCount: 0,
          createdAt: toIso(now),
          updatedAt: toIso(now),
        });
        if (plan.evidence !== undefined) {
          this.#metrics.inc('dvo_evidence_envelopes_total', { direction: 'outbound', tier: String(plan.tier) });
          this.#metrics.observe('dvo_evidence_bytes', Buffer.byteLength(JSON.stringify(plan.evidence)), { direction: 'outbound' });
        }
      }
      starts.push({ attemptId, plan, request, deadlineMs });
    }

    // Attempts, their outbox rows and the decision that caused them land in one transaction.
    await this.#commit(actor, events, outbox);
    await this.#syncPhase(actor, 'attempts launched');
    for (const s of starts) this.#run(actor, s.attemptId, s.plan.executor, s.request, s.deadlineMs, s.plan.peer);
    for (const attemptId of executorFailures) await this.#recordReliability(actor, actor.state.attempts[attemptId]!);
    if (starts.length === 0) await this.#step(actor);
  }

  #request(state: TaskState, attemptId: AttemptId, plan: LaunchPlan, deadlineMs: number, parentEventId: string): ExecutionRequest {
    const correlation: Correlation = {
      taskId: state.taskId,
      attemptId,
      traceId: state.traceId,
      eventId: this.#deps.ids.eventId(),
      parentEventId: parentEventId as Correlation['eventId'],
      idempotencyKey: `${state.taskId}/${attemptId}`,
      occurredAt: toIso(this.#deps.clock.now()),
    };
    const targetId = plan.targets?.[0];
    const target = targetId === undefined ? undefined : state.attempts[targetId];
    return {
      correlation,
      prompt: plan.prompt,
      budget: {
        maxInputTokens: Math.max(0, state.budget.maxInputTokens - state.spent.inputTokens),
        maxOutputTokens: Math.max(0, state.budget.maxOutputTokens - state.spent.outputTokens),
        deadlineAt: toIso(deadlineMs),
      },
      requestedTier: plan.tier,
      classification: plan.classificationSent,
      skill: skillOf(state, this.#config.defaultSkill),
      ...(plan.evidence === undefined ? {} : { evidence: plan.evidence }),
      ...(target?.result?.output === undefined || state.verification === undefined
        ? {}
        : { verification: { targetAttemptId: target.attemptId, candidate: target.result.output, spec: state.verification } }),
    };
  }

  #run(
    actor: TaskActor,
    attemptId: AttemptId,
    executor: Executor,
    request: ExecutionRequest,
    deadlineMs: number,
    peer?: PeerDescriptor,
    resume?: ResumeRef,
  ): void {
    const managed = this.#deps.scheduler.launch({
      taskId: actor.state.taskId,
      attemptId,
      executor,
      request,
      deadlineMs,
      ...(peer === undefined ? {} : { breaker: this.#deps.circuits.get(executor.id) }),
      ...(resume === undefined ? {} : { resume }),
      observer: { onProgress: (p) => void actor.enqueue(() => this.#onProgress(actor, attemptId, p)) },
      onStart: () => void actor.enqueue(() => this.#onStart(actor, attemptId)),
    });
    actor.running.set(attemptId, managed);
    void managed.result.then((result) => actor.enqueue(() => this.#onResult(actor, attemptId, result)));
  }

  async #onStart(actor: TaskActor, attemptId: AttemptId): Promise<void> {
    const attempt = actor.state.attempts[attemptId];
    if (attempt?.status !== 'queued') return;
    await this.#commit(actor, [
      this.#event(actor, 'attempt.status_changed', { from: 'queued', to: 'running', reason: 'executor started' }, { attemptId }),
    ]);
    await this.#syncPhase(actor, 'attempt running');
  }

  async #onProgress(actor: TaskActor, attemptId: AttemptId, progress: ExecutionProgress): Promise<void> {
    const attempt = actor.state.attempts[attemptId];
    if (attempt === undefined || isTerminalAttemptStatus(attempt.status)) return;
    switch (progress.kind) {
      case 'remote_submitted': {
        if (attempt.remoteTaskId !== undefined) return;
        const events: DomainEvent[] = [
          this.#event(
            actor,
            'attempt.remote_submitted',
            { remoteTaskId: progress.remoteTaskId, requestDigest: progress.requestDigest },
            { attemptId },
          ),
        ];
        const status = attempt.status === 'queued' ? 'running' : attempt.status;
        if (attempt.status === 'queued')
          events.push(
            this.#event(actor, 'attempt.status_changed', { from: 'queued', to: 'running', reason: 'executor started' }, { attemptId }),
          );
        if (status === 'running')
          events.push(
            this.#event(
              actor,
              'attempt.status_changed',
              { from: 'running', to: 'awaiting_peer', reason: 'remote submitted' },
              { attemptId },
            ),
          );
        await this.#commit(actor, events);
        await this.#syncPhase(actor, 'awaiting peer');
        return;
      }
      case 'submission_unknown':
        if (attempt.submissionUnknown === true) return;
        await this.#commit(actor, [
          this.#event(
            actor,
            'attempt.submission_unknown',
            { reason: this.#deps.redactor.redactText(progress.reason).value.slice(0, 300) },
            { attemptId },
          ),
        ]);
        return;
      case 'observation_ignored':
        this.#metrics.inc('dvo_transitions_rejected_total', { entity: 'remote_observation' });
        this.#logger.debug({ attemptId, reason: progress.reason }, 'remote observation ignored');
        return;
      case 'started':
      case 'remote_state':
        return;
    }
  }

  // ─── results ──────────────────────────────────────────────────────────────────

  async #onResult(actor: TaskActor, attemptId: AttemptId, result: NormalizedExecutionResult): Promise<void> {
    actor.running.delete(attemptId);
    const attempt = actor.state.attempts[attemptId];
    if (attempt === undefined) return;
    if (isTerminalAttemptStatus(attempt.status)) {
      this.#metrics.inc('dvo_transitions_rejected_total', { entity: 'attempt' });
      await this.#commit(actor, [
        this.#event(
          actor,
          'attempt.transition_rejected',
          { from: attempt.status, to: 'result', reason: 'result for a settled attempt' },
          { attemptId },
        ),
      ]);
      return;
    }

    const late = attempt.status === 'cancel_requested';
    const summary = await this.#summarise(actor, attempt, result, late);
    const usable = summary.terminalStatus === 'completed' && summary.output !== undefined;
    const events: DomainEvent[] = [];
    let path: AttemptStatus[];
    if (late) {
      const accepted = this.#config.acceptLateResults && usable && !actor.state.cancelRequested;
      this.#metrics.inc('dvo_late_results_total', { executor: attempt.executorId, accepted: String(accepted) });
      events.push(
        this.#event(
          actor,
          'attempt.late_result',
          {
            terminalStatus: summary.terminalStatus,
            accepted,
            reason: accepted ? 'valid result arrived after cancel; kept' : 'result after cancel; audited only',
          },
          { attemptId },
        ),
      );
      path = [accepted ? 'succeeded' : 'cancelled'];
    } else if (result.terminalStatus === 'cancelled') {
      path = attemptPath(attempt.status, 'cancelled') ?? ['cancelled'];
    } else if (attempt.status === 'queued') {
      path = ['failed'];
    } else {
      path = ['verifying', usable ? 'succeeded' : 'failed'];
    }

    // Record the result as soon as the attempt is in `verifying` (or immediately for short paths).
    let from = attempt.status;
    let recorded = false;
    for (const to of path) {
      if (!recorded && (to === 'succeeded' || to === 'failed' || to === 'cancelled')) {
        events.push(this.#event(actor, 'attempt.result_recorded', { result: summary }, { attemptId }));
        recorded = true;
      }
      events.push(this.#event(actor, 'attempt.status_changed', { from, to, reason: statusReason(to, summary) }, { attemptId }));
      from = to;
    }
    await this.#commit(actor, events);

    const settled = actor.state.attempts[attemptId]!;
    this.#metrics.inc('dvo_attempts_total', { executor: settled.executorId, kind: settled.executorKind, terminal: summary.terminalStatus });
    this.#metrics.observe('dvo_attempt_duration_seconds', summary.usage.elapsedMs / 1000, { executor: settled.executorId });
    this.#checkBudget(actor);
    await this.#recordReliability(actor, settled);
    if (settled.executorKind === 'verifier') await this.#applyVerification(actor, settled);
    await this.#syncPhase(actor, 'attempt settled');
    await this.#step(actor);
  }

  async #summarise(
    actor: TaskActor,
    attempt: AttemptState,
    result: NormalizedExecutionResult,
    late: boolean,
  ): Promise<AttemptResultSummary> {
    const receivedAt = toIso(this.#deps.clock.now());
    const base = {
      terminalStatus: result.terminalStatus,
      usage: result.usage,
      diagnostics: result.diagnostics.map((d) => ({
        ...d,
        safeMessage: this.#deps.redactor.redactText(d.safeMessage).value.slice(0, 500),
      })),
      late,
      receivedAt,
      ...(result.runtime === undefined ? {} : { runtime: result.runtime }),
    };
    if (result.output === undefined) {
      const invalid = result.terminalStatus === 'completed';
      return {
        ...base,
        ...(invalid
          ? {
              terminalStatus: 'invalid_output' as const,
              diagnostics: [...base.diagnostics, diagnostic('output_missing', 'completed without output')],
            }
          : {}),
        calibratedConfidence: 0,
        quarantined: false,
        injectionRisk: 'low',
        issues: [],
      };
    }
    const peer = attempt.peerId === undefined ? undefined : findPeer(this.#deps.catalog, attempt.peerId);
    const maxTier = peer === undefined ? 2 : (await this.#capabilities.get(peer.executor)).maxEvidenceTier;
    const ingest = this.#gateway.ingest(result.output, {
      source: attempt.executorKind,
      executorId: attempt.executorId,
      correlation: result.output.correlation,
      maxTier,
      ...(peer === undefined ? {} : { artifactPolicy: this.#config.artifactPolicy(peer) }),
    });
    this.#metrics.inc('dvo_evidence_envelopes_total', { direction: 'inbound', tier: String(ingest.envelope.tier) });
    this.#metrics.observe('dvo_evidence_bytes', Buffer.byteLength(JSON.stringify(ingest.envelope)), { direction: 'inbound' });
    if (ingest.injection.level !== 'low') this.#metrics.inc('dvo_injection_flags_total', { level: ingest.injection.level });
    if (ingest.redactionHits > 0) this.#metrics.inc('dvo_redactions_total', { where: 'inbound' });
    for (const r of ingest.artifactRejections)
      this.#metrics.inc('dvo_artifact_rejections_total', { source: attempt.executorId, reason: r.reason });
    const skill = skillOf(actor.state, this.#config.defaultSkill);
    const confidence = primaryClaim(ingest.envelope)?.confidence ?? 0;
    return {
      ...base,
      output: ingest.envelope,
      calibratedConfidence: this.#deps.reliability.calibrate(confidence, attempt.executorId, skill, attempt.executorKind),
      quarantined: ingest.quarantined,
      injectionRisk: ingest.injection.level,
      issues: ingest.issues.slice(0, 20),
    };
  }

  async #applyVerification(actor: TaskActor, verifierAttempt: AttemptState): Promise<void> {
    const verifierId = verifierAttempt.executorId.replace(/^verifier:/, '');
    const outcome = verifierAttempt.result?.terminalStatus === 'completed' ? readVerification(verifierAttempt.result.output) : undefined;
    if (outcome === undefined) {
      // Verifier broken for this task: never promote anything to verified (design §10.2).
      actor.failedVerifiers.add(verifierId);
      await this.#commit(actor, [this.#event(actor, 'task.degraded', { reason: `verifier ${verifierId} unavailable` })]);
      return;
    }
    const events: DomainEvent[] = (verifierAttempt.targetAttemptIds ?? []).map((targetAttemptId) =>
      this.#event(actor, 'verification.recorded', {
        verifierAttemptId: verifierAttempt.attemptId,
        targetAttemptId,
        verifierId,
        outcome: outcome.outcome,
        claimVerdicts: outcome.claimVerdicts,
        ...(outcome.detail === undefined ? {} : { detail: this.#deps.redactor.redactText(outcome.detail).value.slice(0, 500) }),
      }),
    );
    if (events.length === 0) return;
    await this.#commit(actor, events);
    for (const id of verifierAttempt.targetAttemptIds ?? []) {
      const target = actor.state.attempts[id];
      if (target !== undefined) await this.#recordReliability(actor, target);
    }
  }

  /** One reliability observation per attempt (idempotent in the store). */
  async #recordReliability(actor: TaskActor, attempt: AttemptState): Promise<void> {
    if (attempt.executorKind === 'verifier' || attempt.result === undefined || !isTerminalAttemptStatus(attempt.status)) return;
    const status = attempt.result.terminalStatus;
    let success: boolean | undefined;
    if (status === 'cancelled') success = undefined;
    else if (status !== 'completed' || attempt.status === 'failed') success = false;
    else if (attempt.verification === 'verified') success = true;
    else if (attempt.verification === 'refuted') success = false;
    else if (actor.state.verification === undefined) success = true; // nothing will ever verify it
    if (success === undefined) return;
    await this.#deps.reliability.record({
      attemptId: attempt.attemptId,
      executorId: attempt.executorId,
      skill: attempt.skill ?? this.#config.defaultSkill,
      success,
      terminalStatus: status,
      latencyMs: attempt.result.usage.elapsedMs,
      costUsd: attempt.result.usage.costUsd ?? 0,
      artifactFailure: attempt.result.issues.some((i) => i.startsWith('artifact')),
      at: attempt.result.receivedAt,
    });
  }

  #failureSummary(failure: Diagnostic): AttemptResultSummary {
    return {
      terminalStatus: 'failed',
      usage: { elapsedMs: 0, costUsd: 0 },
      diagnostics: [failure],
      calibratedConfidence: 0,
      quarantined: false,
      injectionRisk: 'low',
      issues: [],
      late: false,
      receivedAt: toIso(this.#deps.clock.now()),
    };
  }

  // ─── recovery helpers ─────────────────────────────────────────────────────────

  async #recoverAttempt(actor: TaskActor, attempt: AttemptState): Promise<boolean> {
    const fail = async (code: string, message: string, retryable: boolean): Promise<void> => {
      const target: AttemptStatus = attempt.status === 'cancel_requested' ? 'cancelled' : 'failed';
      const path = attemptPath(attempt.status, target) ?? [target];
      const events: DomainEvent[] = [
        this.#event(
          actor,
          'attempt.result_recorded',
          { result: this.#failureSummary(diagnostic(code, message, retryable)) },
          { attemptId: attempt.attemptId },
        ),
      ];
      let from = attempt.status;
      for (const to of path) {
        events.push(this.#event(actor, 'attempt.status_changed', { from, to, reason: code }, { attemptId: attempt.attemptId }));
        from = to;
      }
      await this.#commit(actor, events);
      this.#metrics.inc('dvo_recovered_attempts_total', { action: 'failed' });
    };

    if (attempt.executorKind !== 'a2a-peer' || attempt.peerId === undefined) {
      await fail('orphaned_on_restart', 'local attempt did not survive a restart', true);
      return false;
    }
    const peer = findPeer(this.#deps.catalog, attempt.peerId);
    const submission = await this.#deps.store.getOutbox(attempt.attemptId);
    if (peer === undefined || peer.executor.resume === undefined || submission === undefined) {
      await fail('unrecoverable_after_restart', 'remote attempt cannot be re-attached', false);
      return false;
    }
    const request: ExecutionRequest = {
      correlation: {
        taskId: actor.state.taskId,
        attemptId: attempt.attemptId,
        traceId: actor.state.traceId,
        eventId: this.#deps.ids.eventId(),
        idempotencyKey: attempt.idempotencyKey,
        occurredAt: attempt.createdAt,
      },
      prompt: '',
      budget: { maxInputTokens: 0, maxOutputTokens: 0, deadlineAt: attempt.deadlineAt },
      requestedTier: attempt.requestedTier,
      classification: actor.state.classification,
      ...(attempt.skill === undefined ? {} : { skill: attempt.skill }),
    };
    this.#run(actor, attempt.attemptId, peer.executor, request, fromIso(attempt.deadlineAt), peer, { request, submission });
    if (attempt.status === 'cancel_requested') actor.running.get(attempt.attemptId)?.cancel('cancel requested before restart');
    this.#metrics.inc('dvo_recovered_attempts_total', {
      action: submission.state === 'submitted' ? 'resumed_polling' : `resumed_${submission.state}`,
    });
    return true;
  }

  // ─── persistence & phases ─────────────────────────────────────────────────────

  #event<T extends DomainEventType>(
    actor: TaskActor,
    type: T,
    payload: EventPayload<T>,
    extra: { attemptId?: AttemptId; parentEventId?: string; eventId?: string } = {},
  ): EventOfType<T> {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: extra.eventId ?? this.#deps.ids.eventId(),
      type,
      taskId: actor.state.taskId,
      traceId: actor.state.traceId,
      occurredAt: toIso(this.#deps.clock.now()),
      ...(extra.attemptId === undefined ? {} : { attemptId: extra.attemptId }),
      ...(extra.parentEventId === undefined ? {} : { parentEventId: extra.parentEventId }),
      payload,
    } as EventOfType<T>;
  }

  async #commit(actor: TaskActor, events: DomainEvent[], outbox: OutboxRecord[] = []): Promise<void> {
    if (events.length === 0) return;
    let next = actor.state;
    for (const event of events) next = applyEvent(next, event);
    await this.#deps.store.commit({ taskId: actor.state.taskId, expectedRevision: actor.state.revision, events, state: next, outbox });
    actor.state = next;
  }

  async #setPhase(actor: TaskActor, to: TaskPhase, reason: string): Promise<void> {
    const from = actor.state.phase;
    if (from === to || !canTransitionTask(from, to)) return;
    await this.#commit(actor, [this.#event(actor, 'task.phase_changed', { from, to, reason })]);
  }

  async #syncPhase(actor: TaskActor, reason: string): Promise<void> {
    if (isTerminalPhase(actor.state.phase)) return;
    await this.#setPhase(actor, desiredPhase(actor.state), reason);
  }

  async #finalize(actor: TaskActor): Promise<void> {
    if (isTerminalPhase(actor.state.phase)) return;
    const stop = actor.pendingStop ?? { reason: 'sufficient_evidence' as FinalizeReason, detail: 'no further action' };
    const outcome = finalOutcome(actor.state, stop.reason, this.#deps.clock.now(), stop.detail);
    const events: DomainEvent[] = [];
    if (canTransitionTask(actor.state.phase, outcome.status)) {
      events.push(this.#event(actor, 'task.phase_changed', { from: actor.state.phase, to: outcome.status, reason: stop.detail }));
    } else {
      // e.g. cancel_requested → succeeded is not allowed: a cancelled task ends cancelled.
      events.push(this.#event(actor, 'task.phase_changed', { from: actor.state.phase, to: 'cancelled', reason: stop.detail }));
    }
    const finalStatus = (events[0] as EventOfType<'task.phase_changed'>).payload.to;
    events.push(this.#event(actor, 'task.finalized', { outcome: { ...outcome, status: finalStatus as typeof outcome.status } }));
    await this.#commit(actor, events);
    actor.dispose();
    this.#actors.delete(actor.state.taskId);
    this.#reportFinal(actor.state);
    for (const resolve of this.#waiters.get(actor.state.taskId) ?? []) resolve(actor.state);
    this.#waiters.delete(actor.state.taskId);
  }

  #reportFinal(state: TaskState): void {
    const outcome = state.outcome!;
    this.#metrics.inc('dvo_tasks_total', { outcome: outcome.status, verification: outcome.verificationStatus });
    this.#metrics.observe('dvo_task_cost_usd', state.spent.costUsd);
    this.#metrics.inc('dvo_task_tokens_total', { direction: 'input' }, state.spent.inputTokens);
    this.#metrics.inc('dvo_task_tokens_total', { direction: 'output' }, state.spent.outputTokens);
    this.#metrics.observe('dvo_task_duration_seconds', (fromIso(outcome.finalizedAt) - fromIso(state.createdAt)) / 1000, {
      outcome: outcome.status,
    });
    for (const attempt of attemptsOf(state)) {
      if (attempt.executorKind === 'verifier' || attempt.result?.output === undefined) continue;
      const label =
        attempt.attemptId === outcome.finalAttemptId
          ? 'final'
          : attempt.verification === 'verified'
            ? 'verified'
            : attempt.verification === 'refuted'
              ? 'refuted'
              : 'unused';
      this.#metrics.inc('dvo_evidence_outcome_total', { outcome: label });
    }
    this.#logger.info(
      { taskId: state.taskId, outcome: outcome.status, verification: outcome.verificationStatus, costUsd: state.spent.costUsd },
      'task finalized',
    );
  }

  #checkBudget(actor: TaskActor): void {
    if (!isOverBudget(actor.state.budget, actor.state.spent)) return;
    const s = actor.state;
    const dimension =
      s.spent.costUsd > s.budget.maxCostUsd ? 'cost' : s.spent.remoteCalls > s.budget.maxRemoteCalls ? 'remote_calls' : 'tokens';
    this.#metrics.inc('dvo_budget_violations_total', { dimension });
    this.#logger.error({ taskId: s.taskId, dimension, spent: s.spent, budget: s.budget }, 'hard budget exceeded by reported usage');
  }
}

function desiredPhase(state: TaskState): TaskPhase {
  if (state.cancelRequested) return 'cancel_requested';
  const active = state.activeAttempts.map((id) => state.attempts[id]!).filter((a) => a !== undefined);
  if (active.some((a) => a.executorKind === 'verifier')) return 'verifying';
  if (active.some((a) => a.executorKind === 'a2a-peer')) return 'awaiting_peer';
  if (active.length > 0) return 'running';
  return state.degradedReasons.length > 0 ? 'degraded' : 'assessing';
}

function statusReason(to: AttemptStatus, summary: AttemptResultSummary): string {
  if (to === 'verifying') return 'result received';
  return summary.diagnostics[0]?.code ?? summary.terminalStatus;
}
