import { afterEach, describe, expect, it } from 'vitest';
import { PeerId, SecretValue } from '@dvo/core';
import { A2aPeerExecutor, AgentCardResolver, classifyFetchFailure, JsonRpcHttpTransport, TaskSchema } from '@dvo/a2a-bridge';
import { chaosFetch, MemoryOutbox, MockA2aPeer, networkError } from '@dvo/testkit';
import { execute, expectedMessageId, request, testPeer } from './helpers.ts';

let peer: MockA2aPeer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});
const start = async (behaviour = {}) => (peer = await MockA2aPeer.start(behaviour));

describe('Agent Card discovery (design §9.1)', () => {
  it('validates, caches and derives the interface and extensions', async () => {
    const p = await start();
    const resolver = new AgentCardResolver();
    const profile = await resolver.resolve(testPeer(p.url));
    expect(profile.rpcUrl).toBe(p.rpcUrl);
    expect(profile.supportsEvidenceExtension).toBe(true);
    expect(profile.cardDigest).toMatch(/^[a-f0-9]{64}$/);
    await resolver.resolve(testPeer(p.url));
    expect(p.cardRequests).toBe(1);
  });

  it('refuses non-allowlisted peers, plain HTTP and cards pointing elsewhere', async () => {
    const p = await start({ advertisedRpcUrl: 'http://evil.example/a2a' });
    const resolver = new AgentCardResolver();
    await expect(resolver.resolve(testPeer(p.url, { allowed: false }))).rejects.toThrow(/not allowlisted/);
    await expect(resolver.resolve(testPeer(p.url, { allowInsecureLoopback: false }))).rejects.toThrow(/HTTPS/);
    await expect(resolver.resolve(testPeer(p.url))).rejects.toThrow(/outside its allowlisted hosts/);
  });

  it('refuses peers that require extensions we do not speak', async () => {
    const p = await start({ requiredExtensions: ['urn:other:required:v1'] });
    await expect(new AgentCardResolver().resolve(testPeer(p.url))).rejects.toThrow(/requires unsupported extensions/);
  });
});

describe('task lifecycle over JSON-RPC (design §9.2)', () => {
  it('extension mode: submits, polls and returns a validated tier-1 envelope', async () => {
    const p = await start({ workingPolls: 2 });
    const req = request();
    const { result, ledger, progress } = await execute(testPeer(p.url), req);
    expect(result.terminalStatus).toBe('completed');
    expect(result.output!.claims[0]!.statement).toBe('42');
    expect(JSON.stringify(result.output)).not.toContain('unexpectedField');
    expect(ledger.records.get(req.correlation.attemptId!)!.state).toBe('submitted');
    expect(progress).toContain('remote_submitted');

    const send = p.callsOf('SendMessage')[0]!;
    const params = send.params as {
      message: { messageId: string; extensions: string[]; metadata: Record<string, { idempotencyKey: string }> };
    };
    expect(params.message.messageId).toBe(expectedMessageId(req));
    expect(params.message.metadata['urn:research:dvo:evidence-envelope:v1']!.idempotencyKey).toBe(req.correlation.idempotencyKey);
    expect(send.headers['a2a-version']).toBe('1.0');
    expect(send.headers['a2a-extensions']).toBe('urn:research:dvo:evidence-envelope:v1');
    expect(String(send.headers['traceparent'])).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
  });

  it('degrades to a tier-0 Data Part and a synthesized envelope for peers without the extension', async () => {
    const p = await start({ declareExtension: false, envelopeMode: 'text' });
    const { result } = await execute(testPeer(p.url), request());
    expect(result.terminalStatus).toBe('completed');
    expect(result.output!.tier).toBe(0);
    expect(result.output!.claims[0]).toMatchObject({ statement: '42', confidence: 0, status: 'proposed' });
    expect(result.diagnostics[0]!.code).toBe('tier0_fallback');
    const send = p.callsOf('SendMessage')[0]!;
    expect(send.headers['a2a-extensions']).toBeUndefined();
    const parts = (send.params as { message: { parts: Array<{ data?: { tier: number; evidence: unknown[] } }> } }).message.parts;
    expect(parts[1]!.data).toMatchObject({ tier: 0, evidence: [] });
  });

  it('sends bearer credentials from the secret provider', async () => {
    const p = await start();
    await execute(testPeer(p.url, { authScheme: 'bearer', credentialsRef: 'secret://a2a/peer-test' }), request());
    expect(p.callsOf('SendMessage')[0]!.headers['authorization']).toBe('Bearer peer-token-123');
  });

  it('maps failed, rejected and input-required tasks', async () => {
    let p = await start({ finalState: 'TASK_STATE_FAILED' });
    expect((await execute(testPeer(p.url), request())).result.diagnostics[0]!.code).toBe('peer_failed');
    await p.close();
    p = await start({ finalState: 'TASK_STATE_REJECTED' });
    expect((await execute(testPeer(p.url), request())).result.terminalStatus).toBe('refused');
    await p.close();
    p = await start({ finalState: 'TASK_STATE_INPUT_REQUIRED' });
    const interrupted = await execute(testPeer(p.url), request());
    expect(interrupted.result.diagnostics[0]!.code).toBe('peer_interrupted');
    expect(p.callsOf('CancelTask')).toHaveLength(1);
  });
});

describe('delivery semantics (design §10.2, §16.1)', () => {
  it('third-party peer: unknown submission is never blindly resent', async () => {
    const p = await start({ dedupByMessageId: false });
    const fetch = chaosFetch({ resetAfterSendFirst: 1, method: 'SendMessage' });
    const req = request();
    const { result, ledger } = await execute(testPeer(p.url, { dedupSupported: false }), req, { fetch });
    expect(result.diagnostics[0]!.code).toBe('submission_unknown');
    expect(p.callsOf('SendMessage')).toHaveLength(1);
    expect(p.tasks.size).toBe(1); // the peer did create it; we must not create a second one
    expect(ledger.records.get(req.correlation.attemptId!)!.state).toBe('submission_unknown');
  });

  it('de-duplicating peer: the resend carries the same messageId and yields one remote task', async () => {
    const p = await start({ dedupByMessageId: true });
    const fetch = chaosFetch({ resetAfterSendFirst: 1, method: 'SendMessage' });
    const req = request();
    const { result } = await execute(testPeer(p.url, { dedupSupported: true }), req, { fetch });
    expect(result.terminalStatus).toBe('completed');
    const ids = p.callsOf('SendMessage').map((c) => (c.params as { message: { messageId: string } }).message.messageId);
    expect(ids).toEqual([expectedMessageId(req), expectedMessageId(req)]);
    expect(p.tasks.size).toBe(1);
  });

  it('provably unsent requests (connection refused, 429) are retried safely', async () => {
    const p = await start({ sendFailure: { mode: 'http429', count: 1 } });
    const fetch = chaosFetch({ refuseFirst: 1, method: 'SendMessage' });
    const { result } = await execute(testPeer(p.url), request(), { fetch });
    expect(result.terminalStatus).toBe('completed');
    expect(fetch.refused).toBe(1);
    expect(p.tasks.size).toBe(1);
  });

  it('a definite JSON-RPC error abandons the submission', async () => {
    const p = await start({ sendFailure: { mode: 'rpc_internal', count: 5 } });
    const req = request();
    const { result, ledger } = await execute(testPeer(p.url), req);
    expect(result.terminalStatus).toBe('failed');
    expect(ledger.records.get(req.correlation.attemptId!)!.state).toBe('abandoned');
  });

  it('HTTP 5xx on send is an unknown outcome, not a retry', async () => {
    const p = await start({ sendFailure: { mode: 'http500', count: 1 } });
    const { result } = await execute(testPeer(p.url), request());
    expect(result.diagnostics[0]!.code).toBe('submission_unknown');
    expect(p.callsOf('SendMessage')).toHaveLength(1);
  });
});

describe('polling robustness', () => {
  it('ignores out-of-order observations: state never regresses', async () => {
    const p = await start({ stateSequence: ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'] });
    const { result, progress } = await execute(testPeer(p.url), request());
    expect(result.terminalStatus).toBe('completed');
    expect(progress.some((p) => p.startsWith('ignored:out-of-order TASK_STATE_SUBMITTED'))).toBe(true);
  });

  it('rides out transient poll failures and reports lost tasks', async () => {
    let p = await start({ pollFailures: 2 });
    expect((await execute(testPeer(p.url), request())).result.terminalStatus).toBe('completed');
    await p.close();
    p = await start({ loseTasks: true });
    expect((await execute(testPeer(p.url), request())).result.diagnostics[0]!.code).toBe('remote_task_lost');
  });
});

describe('cancellation (invariant 3)', () => {
  const run = async (behaviour: object) => {
    const p = await start({ workingPolls: 10_000, ...behaviour });
    const ledger = new MemoryOutbox();
    const executor = new A2aPeerExecutor(testPeer(p.url), { resolver: new AgentCardResolver(), ledger });
    const req = request();
    const prepared = await executor.prepare(req);
    ledger.insert({
      attemptId: req.correlation.attemptId!,
      taskId: req.correlation.taskId,
      peerId: PeerId('peer-test'),
      state: 'pending',
      requestDigest: prepared.requestDigest,
      idempotencyKey: 'k',
      payload: prepared.payload,
      sendCount: 0,
      createdAt: 'n',
      updatedAt: 'n',
    });
    const handle = await executor.start(req);
    await new Promise((r) => setTimeout(r, 60));
    await handle.cancel('test');
    return { result: await handle.result(), p };
  };

  it('sends CancelTask and reports cancelled', async () => {
    const { result, p } = await run({});
    expect(result.terminalStatus).toBe('cancelled');
    expect(p.callsOf('CancelTask')).toHaveLength(1);
  });

  it('degrades deterministically when the peer cannot cancel', async () => {
    expect((await run({ cancel: 'unsupported' })).result.diagnostics[0]!.code).toBe('cancel_unsupported');
    expect((await run({ cancel: 'not_cancelable' })).result.diagnostics[0]!.code).toBe('cancel_not_cancelable');
  });

  it('a task that completed before the cancel landed comes back as a late result', async () => {
    const { result } = await run({ completeOnCancel: true });
    expect(result.terminalStatus).toBe('completed');
    expect(result.afterCancel).toBe(true);
  });
});

describe('restart recovery via the outbox', () => {
  it('resumes polling a submitted task, and refuses to resend an interrupted send', async () => {
    const p = await start();
    const first = await execute(testPeer(p.url), request());
    const remoteTaskId = first.result.remoteTaskId!;
    const ledger = new MemoryOutbox();
    const executor = new A2aPeerExecutor(testPeer(p.url), { resolver: new AgentCardResolver(), ledger });
    const req = request();
    const prepared = await executor.prepare(req);
    const record = {
      attemptId: req.correlation.attemptId!,
      taskId: req.correlation.taskId,
      peerId: PeerId('peer-test'),
      requestDigest: prepared.requestDigest,
      idempotencyKey: 'k',
      payload: prepared.payload,
      sendCount: 1,
      createdAt: 'n',
      updatedAt: 'n',
    };

    ledger.insert({ ...record, state: 'submitted', remoteTaskId });
    const resumed = await (await executor.resume({ request: req })).result();
    expect(resumed.terminalStatus).toBe('completed');

    ledger.insert({ ...record, state: 'sending' });
    const interrupted = await (await executor.resume({ request: req })).result();
    expect(interrupted.diagnostics[0]!.code).toBe('submission_unknown');
    expect(ledger.records.get(req.correlation.attemptId!)!.state).toBe('submission_unknown');
  });
});

describe('transport classification', () => {
  it('distinguishes never-sent from maybe-processed failures', () => {
    expect(classifyFetchFailure(networkError('ECONNREFUSED'))).toBe('not_sent');
    expect(classifyFetchFailure(networkError('ECONNRESET'))).toBe('unknown');
    expect(classifyFetchFailure(new Error('weird'))).toBe('unknown');
  });

  it('caps response size and validates the JSON-RPC envelope', async () => {
    const huge = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'x'.repeat(5000), status: { state: 'TASK_STATE_WORKING' } } }), {
        status: 200,
      });
    const t = new JsonRpcHttpTransport({ fetch: huge, requestTimeoutMs: 1000, maxResponseBytes: 1000, peerLabel: 'p' });
    await expect(t.call('http://x', 'GetTask', { id: 'x' }, TaskSchema, { headers: {} })).rejects.toThrow(/unreadable/);
    const wrongId = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }), { status: 200 });
    const t2 = new JsonRpcHttpTransport({ fetch: wrongId, requestTimeoutMs: 1000, maxResponseBytes: 10_000, peerLabel: 'p' });
    await expect(t2.call('http://x', 'GetTask', { id: 'x' }, TaskSchema, { headers: {} })).rejects.toThrow(/invalid JSON-RPC envelope/);
  });

  it('never leaks credentials into results', async () => {
    const p = await start({ finalState: 'TASK_STATE_FAILED' });
    const { result } = await execute(testPeer(p.url, { authScheme: 'bearer', credentialsRef: 'secret://x' }), request(), {
      secrets: { resolve: async () => new SecretValue('sk-' + 'L'.repeat(30)) },
    });
    expect(JSON.stringify(result)).not.toContain('LLLLLLLL');
  });
});
