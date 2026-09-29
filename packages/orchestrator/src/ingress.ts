import {
  applyEvent,
  type Budget,
  type Clock,
  DATA_CLASSIFICATIONS,
  type DataClassification,
  EVENT_SCHEMA_VERSION,
  type IdGenerator,
  maxClassification,
  type TaskCreatedEvent,
  type TaskId,
  type TaskRepository,
  type TaskSpec,
  type TraceId,
  toIso,
  ValidationError,
} from '@dvo/core';
import type { Redactor } from '@dvo/evidence';
import { estimateHardness } from '@dvo/policy';

/** Hard ceilings and defaults for task budgets (design §18.3). */
export interface IngressLimits {
  maxGoalChars: number;
  ceilings: Omit<Budget, 'deadlineAt'> & { deadlineMs: number };
  defaults: Omit<Budget, 'deadlineAt'> & { deadlineMs: number };
  defaultClassification: DataClassification;
  defaultSuccessValueUsd: number;
  maxSuccessValueUsd: number;
}

export const DEFAULT_INGRESS_LIMITS: IngressLimits = {
  maxGoalChars: 20_000,
  ceilings: {
    maxCostUsd: 10,
    maxInputTokens: 2_000_000,
    maxOutputTokens: 200_000,
    maxRemoteCalls: 16,
    maxParallelAttempts: 4,
    deadlineMs: 60 * 60_000,
  },
  defaults: {
    maxCostUsd: 0.5,
    maxInputTokens: 200_000,
    maxOutputTokens: 20_000,
    maxRemoteCalls: 4,
    maxParallelAttempts: 2,
    deadlineMs: 5 * 60_000,
  },
  defaultClassification: 'internal',
  defaultSuccessValueUsd: 1,
  maxSuccessValueUsd: 100,
};

export interface SubmitOptions {
  /** Client idempotency key (HTTP `Idempotency-Key`): the same key always returns the same task. */
  clientRequestKey?: string;
}

export interface SubmitResult {
  taskId: TaskId;
  traceId: TraceId;
  created: boolean;
}

/**
 * Task ingress (design §4.1 `task-ingress`): validates budget and permissions, redacts the
 * goal (the only form ever stored), estimates hardness and creates the trace. It never
 * picks a model or topology.
 */
export class TaskIngress {
  readonly #store: TaskRepository;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #redactor: Redactor;
  readonly #limits: IngressLimits;
  readonly #knownVerifier: (id: string) => boolean;

  constructor(deps: {
    store: TaskRepository;
    ids: IdGenerator;
    clock: Clock;
    redactor: Redactor;
    limits?: IngressLimits;
    knownVerifier: (id: string) => boolean;
  }) {
    this.#store = deps.store;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
    this.#redactor = deps.redactor;
    this.#limits = deps.limits ?? DEFAULT_INGRESS_LIMITS;
    this.#knownVerifier = deps.knownVerifier;
  }

  async submit(spec: TaskSpec, options: SubmitOptions = {}): Promise<SubmitResult> {
    if (options.clientRequestKey !== undefined) {
      const existing = await this.#existing(options.clientRequestKey);
      if (existing !== undefined) return existing;
    }
    const event = this.#createEvent(spec, options);
    const state = applyEvent(undefined, event);
    try {
      await this.#store.commit({ taskId: state.taskId, expectedRevision: 0, events: [event], state });
    } catch (error) {
      // Two concurrent submissions with one key: the loser returns the winner's task.
      if (options.clientRequestKey !== undefined) {
        const existing = await this.#existing(options.clientRequestKey);
        if (existing !== undefined) return existing;
      }
      throw error;
    }
    return { taskId: state.taskId, traceId: state.traceId, created: true };
  }

  async #existing(key: string): Promise<SubmitResult | undefined> {
    const taskId = await this.#store.findByClientKey(key);
    if (taskId === undefined) return undefined;
    const state = await this.#store.load(taskId);
    if (state === undefined) return undefined;
    return { taskId, traceId: state.traceId, created: false };
  }

  #createEvent(spec: TaskSpec, options: SubmitOptions): TaskCreatedEvent {
    const limits = this.#limits;
    const issues: string[] = [];
    const goal = typeof spec.goal === 'string' ? spec.goal.trim() : '';
    if (goal === '') issues.push('goal must be a non-empty string');
    if (goal.length > limits.maxGoalChars) issues.push(`goal exceeds ${limits.maxGoalChars} characters`);
    const classification = spec.classification ?? limits.defaultClassification;
    if (!DATA_CLASSIFICATIONS.includes(classification)) issues.push('unknown classification');

    const requested = spec.budget ?? {};
    const pick = (field: keyof IngressLimits['defaults']): number => {
      const value = requested[field] ?? limits.defaults[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) issues.push(`budget.${field} must be a non-negative number`);
      else if (value > limits.ceilings[field]) issues.push(`budget.${field} exceeds the ceiling ${limits.ceilings[field]}`);
      return value;
    };
    const maxCostUsd = pick('maxCostUsd');
    const maxInputTokens = pick('maxInputTokens');
    const maxOutputTokens = pick('maxOutputTokens');
    const maxRemoteCalls = pick('maxRemoteCalls');
    const maxParallelAttempts = pick('maxParallelAttempts');
    const deadlineMs = pick('deadlineMs');
    if (maxParallelAttempts < 1) issues.push('budget.maxParallelAttempts must be at least 1');

    if (spec.verification !== undefined && !this.#knownVerifier(spec.verification.verifierId)) {
      issues.push(`unknown verifier "${spec.verification.verifierId}"`);
    }
    const requiredSkills = spec.requiredSkills ?? [];
    if (!Array.isArray(requiredSkills) || requiredSkills.some((s) => typeof s !== 'string' || s.length > 64))
      issues.push('requiredSkills must be short strings');
    const successValueUsd = spec.successValueUsd ?? limits.defaultSuccessValueUsd;
    if (!(successValueUsd >= 0 && successValueUsd <= limits.maxSuccessValueUsd))
      issues.push(`successValueUsd must be within [0, ${limits.maxSuccessValueUsd}]`);
    if (issues.length > 0) throw new ValidationError('invalid task specification', issues);

    const redacted = this.#redactor.redactText(goal);
    // A goal that contained credentials is kept local no matter what the caller asked for.
    const effectiveClassification = redacted.hits > 0 ? maxClassification(classification, 'restricted') : classification;

    const now = this.#clock.now();
    const hardness = estimateHardness({
      goal: redacted.value,
      requiredSkills,
      hasVerifier: spec.verification !== undefined,
      ...(spec.hints === undefined ? {} : { hints: spec.hints }),
    });
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: this.#ids.eventId(),
      type: 'task.created',
      taskId: this.#ids.taskId(),
      traceId: this.#ids.traceId(),
      occurredAt: toIso(now),
      payload: {
        userGoal: redacted.value,
        classification: effectiveClassification,
        budget: { maxCostUsd, maxInputTokens, maxOutputTokens, maxRemoteCalls, maxParallelAttempts, deadlineAt: toIso(now + deadlineMs) },
        hardness,
        ...(spec.verification === undefined ? {} : { verification: spec.verification }),
        requiredSkills: [...requiredSkills],
        allowRemote: spec.allowRemote ?? true,
        successValueUsd,
        safeForExploration: spec.safeForExploration === true,
        ...(options.clientRequestKey === undefined ? {} : { clientRequestKey: options.clientRequestKey }),
        redactionApplied: redacted.hits > 0,
        labels: { ...(spec.labels ?? {}) },
      },
    };
  }
}
