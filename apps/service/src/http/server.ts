import { timingSafeEqual } from 'node:crypto';
import {
  attemptsOf,
  HarnessError,
  isHarnessError,
  isTerminalPhase,
  PeerId,
  primaryClaim,
  TaskId,
  type TaskSpec,
  type TaskState,
  ValidationError,
} from '@dvo/core';
import { replayTask } from '@dvo/trace';
import Fastify, { type FastifyError } from 'fastify';
import type { Logger as PinoLogger } from 'pino';
import { z } from 'zod';
import type { App } from '../compose.ts';

const classification = z.enum(['public', 'internal', 'restricted', 'secret']);
const unit = z.number().min(0).max(1);

/** HTTP task submission (validated before ingress applies its semantic limits). */
export const TaskSpecSchema = z
  .object({
    goal: z.string().min(1).max(50_000),
    classification: classification.optional(),
    budget: z
      .object({
        maxCostUsd: z.number().nonnegative(),
        maxInputTokens: z.number().int().nonnegative(),
        maxOutputTokens: z.number().int().nonnegative(),
        maxRemoteCalls: z.number().int().nonnegative(),
        maxParallelAttempts: z.number().int().positive(),
        deadlineMs: z.number().int().positive(),
      })
      .partial()
      .strict()
      .optional(),
    verification: z
      .object({ verifierId: z.string().max(64), params: z.record(z.string(), z.unknown()).optional() })
      .strict()
      .optional(),
    requiredSkills: z.array(z.string().max(64)).max(16).optional(),
    allowRemote: z.boolean().optional(),
    successValueUsd: z.number().nonnegative().optional(),
    safeForExploration: z.boolean().optional(),
    hints: z
      .object({
        subtaskCount: z.number().int().nonnegative(),
        criticalPathLength: z.number().nonnegative(),
        requiredSkills: z.array(z.string().max(64)).max(16),
        independentSubtasks: z.boolean(),
        profile: z
          .object({
            reasoningDepth: unit,
            skillBreadth: unit,
            dependencyCoupling: unit,
            informationFragmentation: unit,
            ambiguity: unit,
            verifiability: unit,
            currentFailureRisk: unit,
          })
          .partial()
          .strict(),
      })
      .partial()
      .strict()
      .optional(),
    labels: z.record(z.string().max(64), z.string().max(256)).optional(),
  })
  .strict();

const ReasonSchema = z.object({ reason: z.string().min(1).max(500) }).strict();
const ApprovalSchema = z.object({ approver: z.string().min(1).max(100), reason: z.string().min(1).max(500) }).strict();

export async function createServer(app: App, logger: PinoLogger) {
  const http = Fastify({ loggerInstance: logger, bodyLimit: app.config.service.http.bodyLimitBytes });
  const tokenRef = app.config.service.http.apiTokenRef;
  const token = tokenRef === undefined ? undefined : Buffer.from((await app.secrets.resolve(tokenRef)).reveal());

  http.addHook('onRequest', async (request, reply) => {
    const open =
      request.url === '/healthz' || request.url === '/readyz' || (request.url === '/metrics' && !app.config.service.http.protectMetrics);
    if (token === undefined || open) return;
    const header = request.headers.authorization ?? '';
    const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
      await reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
  });

  http.setErrorHandler(async (error: FastifyError | HarnessError, _request, reply) => {
    if (error instanceof ValidationError)
      return reply.code(400).send({ error: error.code, message: error.safeMessage, issues: error.issues });
    if (isHarnessError(error)) return reply.code(statusFor(error.code)).send({ error: error.code, message: error.safeMessage });
    if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    }
    app.logger.error({ error: error.message }, 'unhandled request error');
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  http.get('/healthz', async () => ({ status: 'ok' }));

  http.get('/readyz', async (_request, reply) => {
    const checks: Record<string, unknown> = {};
    let ready = true;
    try {
      await app.store.listTasks({ limit: 1 });
      checks['store'] = 'ok';
    } catch {
      checks['store'] = 'unavailable';
      ready = false;
    }
    if (app.catalog.local !== undefined) {
      const caps = await app.engine.capabilities.get(app.catalog.local.executor);
      checks['localRuntime'] = caps.available ? 'ok' : `degraded: ${caps.degradedReason ?? 'unavailable'}`;
    }
    checks['peers'] = Object.fromEntries(app.catalog.peers.map((p) => [p.peerId, app.circuits.get(p.executor.id).state]));
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  http.get('/metrics', async (_request, reply) => reply.type('text/plain; version=0.0.4').send(app.metrics.render()));

  http.post('/v1/tasks', async (request, reply) => {
    // Round-trip drops absent optionals (`undefined`), matching the TaskSpec shape exactly.
    const spec = JSON.parse(JSON.stringify(parse(TaskSpecSchema, request.body))) as TaskSpec;
    const key = request.headers['idempotency-key'];
    const clientRequestKey = typeof key === 'string' && key !== '' ? key.slice(0, 200) : undefined;
    const result = await app.engine.submit(spec, clientRequestKey === undefined ? {} : { clientRequestKey });
    return reply
      .code(result.created ? 202 : 200)
      .header('location', `/v1/tasks/${result.taskId}`)
      .send({ ...result, links: links(result.taskId) });
  });

  http.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => view(await load(app, request.params.taskId)));

  http.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/result', async (request, reply) => {
    const state = await load(app, request.params.taskId);
    if (!isTerminalPhase(state.phase) || state.outcome === undefined)
      return reply.code(202).send({ taskId: state.taskId, phase: state.phase });
    return { taskId: state.taskId, ...state.outcome, spent: state.spent };
  });

  http.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/cancel', async (request, reply) => {
    const { reason } = parse(ReasonSchema, request.body ?? { reason: 'cancelled via API' });
    const state = await app.engine.cancel(TaskId(request.params.taskId), reason, 'api');
    if (state === undefined) throw new HarnessError('not_found', 'task not found');
    return reply.code(202).send({ taskId: state.taskId, phase: state.phase });
  });

  http.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/approvals', async (request) => {
    const { approver, reason } = parse(ApprovalSchema, request.body);
    const state = await app.engine.approve(TaskId(request.params.taskId), approver, reason);
    if (state === undefined) throw new HarnessError('not_found', 'task not found');
    return { taskId: state.taskId, approvals: state.approvals };
  });

  http.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/events', async (request) => {
    await load(app, request.params.taskId);
    return app.store.events(TaskId(request.params.taskId));
  });

  http.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/decisions', async (request) => {
    await load(app, request.params.taskId);
    return app.store.decisions(TaskId(request.params.taskId));
  });

  http.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/replay', async (request) => {
    await load(app, request.params.taskId);
    return replayTask(app.store, TaskId(request.params.taskId));
  });

  http.get('/v1/tasks', async () => app.store.listTasks({ limit: 100 }));

  http.get('/v1/peers', async () => {
    const stats = await app.store.executorStats();
    return app.catalog.peers.map((p) => {
      const cfg = app.peers.get(p.peerId)!;
      const s = stats.filter((x) => x.executorId === p.executor.id);
      return {
        peerId: p.peerId,
        endpoint: cfg.endpoint,
        trustTier: p.trustTier,
        circuit: app.circuits.get(p.executor.id).state,
        successes: s.reduce((n, x) => n + x.successCount, 0),
        failures: s.reduce((n, x) => n + x.failureCount, 0),
        timeouts: s.reduce((n, x) => n + x.timeoutCount, 0),
      };
    });
  });

  http.post<{ Params: { peerId: string; action: string } }>('/v1/peers/:peerId/circuit/:action', async (request) => {
    const peer = app.catalog.peers.find((p) => p.peerId === PeerId(request.params.peerId));
    if (peer === undefined) throw new HarnessError('not_found', 'peer not found');
    const breaker = app.circuits.get(peer.executor.id);
    if (request.params.action === 'reset') breaker.reset('operator reset');
    else if (request.params.action === 'trip') breaker.trip('operator trip');
    else throw new ValidationError('action must be reset or trip');
    app.engine.capabilities.invalidate(peer.executor.id);
    return { peerId: peer.peerId, circuit: breaker.state };
  });

  return http;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ValidationError(
      'invalid request body',
      result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  return result.data;
}

async function load(app: App, taskId: string): Promise<TaskState> {
  const state = await app.engine.get(TaskId(taskId));
  if (state === undefined) throw new HarnessError('not_found', 'task not found');
  return state;
}

function links(taskId: string): Record<string, string> {
  const base = `/v1/tasks/${taskId}`;
  return { self: base, result: `${base}/result`, events: `${base}/events`, decisions: `${base}/decisions`, cancel: `${base}/cancel` };
}

/** Public view of a task: enough to act on, nothing a caller did not already supply. */
function view(state: TaskState): Record<string, unknown> {
  return {
    taskId: state.taskId,
    traceId: state.traceId,
    phase: state.phase,
    revision: state.revision,
    classification: state.classification,
    budget: state.budget,
    spent: state.spent,
    reserved: state.reserved,
    hardness: state.hardnessProfile,
    degradedReasons: state.degradedReasons,
    outcome: state.outcome,
    attempts: attemptsOf(state).map((a) => ({
      attemptId: a.attemptId,
      executorId: a.executorId,
      kind: a.executorKind,
      purpose: a.purpose,
      status: a.status,
      verification: a.verification,
      terminalStatus: a.result?.terminalStatus,
      answer: primaryClaim(a.result?.output)?.statement,
      calibratedConfidence: a.result?.calibratedConfidence,
      quarantined: a.result?.quarantined,
      diagnostics: a.result?.diagnostics.map((d) => d.code),
    })),
    links: links(state.taskId),
  };
}

function statusFor(code: HarnessError['code']): number {
  switch (code) {
    case 'validation_failed':
      return 400;
    case 'not_found':
      return 404;
    case 'revision_conflict':
      return 409;
    case 'peer_not_allowed':
    case 'approval_required':
    case 'unsafe_egress':
      return 403;
    case 'budget_exceeded':
      return 402;
    case 'runtime_unavailable':
      return 503;
    default:
      return 500;
  }
}
