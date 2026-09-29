import { AttemptId, type ExecutionRequest, type NormalizedExecutionResult, PeerId, SecretValue, toIso, uuidv5 } from '@dvo/core';
import { A2aPeerExecutor, type A2aPeerExecutorDeps, AgentCardResolver, peerConfig, type PeerConfig } from '@dvo/a2a-bridge';
import { correlation, envelope, MemoryOutbox } from '@dvo/testkit';

export const fastPoll = { initialDelayMs: 5, maxDelayMs: 20, multiplier: 1.5 };

export function testPeer(endpoint: string, overrides: Partial<PeerConfig> = {}): PeerConfig {
  return peerConfig({
    id: PeerId('peer-test'),
    endpoint,
    allowInsecureLoopback: true,
    extensionUris: ['urn:research:dvo:evidence-envelope:v1'],
    poll: fastPoll,
    requestTimeoutMs: 2_000,
    ...overrides,
  });
}

let counter = 0;
export function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  counter += 1;
  const attemptId = AttemptId(`att_a2a_${counter}`);
  return {
    correlation: correlation({ attemptId, idempotencyKey: `tsk_test/${attemptId}` }),
    prompt: 'Task: compute 6*7',
    budget: { maxInputTokens: 0, maxOutputTokens: 0, deadlineAt: toIso(Date.now() + 30_000) },
    requestedTier: 1,
    classification: 'internal',
    evidence: envelope('prior answer 41'),
    ...overrides,
  };
}

/** Wires an executor to an outbox the way the engine does: prepare → persist pending → start. */
export async function execute(
  peer: PeerConfig,
  req: ExecutionRequest,
  deps: Partial<A2aPeerExecutorDeps> = {},
): Promise<{ result: NormalizedExecutionResult; ledger: MemoryOutbox; executor: A2aPeerExecutor; progress: string[] }> {
  const ledger = (deps.ledger as MemoryOutbox | undefined) ?? new MemoryOutbox();
  const executor = new A2aPeerExecutor(peer, {
    resolver: new AgentCardResolver(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    secrets: { resolve: async () => new SecretValue('peer-token-123') },
    ...deps,
    ledger,
  });
  const prepared = await executor.prepare(req);
  ledger.insert({
    attemptId: req.correlation.attemptId!,
    taskId: req.correlation.taskId,
    peerId: peer.id,
    state: 'pending',
    requestDigest: prepared.requestDigest,
    idempotencyKey: req.correlation.idempotencyKey,
    payload: prepared.payload,
    sendCount: 0,
    createdAt: 'now',
    updatedAt: 'now',
  });
  const progress: string[] = [];
  const handle = await executor.start(req, {
    onProgress: (p) => progress.push(p.kind === 'observation_ignored' ? `ignored:${p.reason}` : p.kind),
  });
  return { result: await handle.result(), ledger, executor, progress };
}

export function expectedMessageId(req: ExecutionRequest): string {
  return uuidv5(req.correlation.idempotencyKey);
}
