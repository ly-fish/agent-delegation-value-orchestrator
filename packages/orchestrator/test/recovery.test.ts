import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptsOf, type Executor, isTerminalPhase, PeerId, RandomIdGenerator, systemClock, type TaskId } from '@dvo/core';
import { A2aPeerExecutor, AgentCardResolver, peerConfig } from '@dvo/a2a-bridge';
import { OrchestrationEngine, ReliabilityTracker } from '@dvo/orchestrator';
import { DvoRulePolicy } from '@dvo/policy';
import { AttemptScheduler, CircuitRegistry } from '@dvo/scheduler';
import { SqliteStore } from '@dvo/trace';
import { ExactAnswerVerifier, VerifierRegistry } from '@dvo/verifier';
import { MockA2aPeer, ScriptedExecutor } from '@dvo/testkit';
import { redactor } from './harness.ts';

let dir = '';
let peer: MockA2aPeer | undefined;
afterEach(async () => {
  await peer?.close();
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

function engineOn(store: SqliteStore, local: Executor | undefined, peers: Executor[]) {
  return new OrchestrationEngine({
    store,
    policy: new DvoRulePolicy(),
    scheduler: new AttemptScheduler({ clock: systemClock, globalConcurrency: 8, executorConcurrency: () => 2, cancelGraceMs: 500 }),
    catalog: {
      ...(local === undefined ? {} : { local: { executor: local, costEstimateUsd: 0.002, timeoutMs: 20_000, maxConcurrency: 1 } }),
      peers: peers.map((executor) => ({
        peerId: PeerId(executor.id),
        executor,
        trustTier: 'internal' as const,
        allowRestricted: false,
        costPerCallUsd: 0.01,
        timeoutMs: 20_000,
        maxConcurrency: 2,
      })),
      verifiers: new VerifierRegistry([new ExactAnswerVerifier()]),
    },
    circuits: new CircuitRegistry(systemClock),
    reliability: new ReliabilityTracker(store),
    redactor,
    clock: systemClock,
    ids: new RandomIdGenerator(systemClock),
  });
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('restart recovery (design §10.2, §16.1)', () => {
  it('re-attaches a submitted remote task and replaces an orphaned local attempt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dvo-recovery-'));
    const path = join(dir, 'dvo.db');
    peer = await MockA2aPeer.start({ workingPolls: 1_000_000 });
    const config = {
      id: PeerId('peer-a'),
      endpoint: peer.url,
      allowInsecureLoopback: true,
      extensionUris: ['urn:research:dvo:evidence-envelope:v1'],
    };

    // ── process 1: submits, then crashes while both attempts are in flight ──
    const store1 = new SqliteStore(path, { sanitize: (v) => redactor.redact(v).value });
    const slowPoll = peerConfig({ ...config, poll: { initialDelayMs: 60_000, maxDelayMs: 60_000, multiplier: 1 } });
    const remote1 = new A2aPeerExecutor(slowPoll, { resolver: new AgentCardResolver(), ledger: store1 });
    // Seed history so the policy prefers the peer for the first task.
    for (let i = 0; i < 20; i++)
      await store1.recordOutcome({
        attemptId: `seed-${i}` as never,
        executorId: 'peer-a',
        skill: 'general',
        success: i < 18,
        terminalStatus: 'completed',
        latencyMs: 500,
        costUsd: 0.01,
        artifactFailure: false,
        at: 'seed',
      });
    const hangingLocal = new ScriptedExecutor({ id: 'dsh-local', clock: systemClock, script: [{ kind: 'hang' }] });
    const engine1 = engineOn(store1, undefined, [remote1]);
    await new ReliabilityTracker(store1).refresh();
    const { taskId: remoteTask } = await engine1.submit({
      goal: 'What is 6 * 7?',
      verification: { verifierId: 'exact-answer', params: { expected: 42 } },
    });
    const localEngine1 = engineOn(store1, hangingLocal, []);
    const { taskId: localTask } = await localEngine1.submit({
      goal: 'What is 6 * 7?',
      allowRemote: false,
      verification: { verifierId: 'exact-answer', params: { expected: 42 } },
    });

    const attemptOf = async (taskId: TaskId) => attemptsOf((await store1.load(taskId))!)[0];
    await until(async () => (await attemptOf(remoteTask))?.status === 'awaiting_peer');
    await until(async () => (await attemptOf(localTask))?.status === 'running');
    expect(peer.callsOf('SendMessage')).toHaveLength(1);
    await engine1.shutdown();
    await localEngine1.shutdown();
    await store1.close(); // the process is gone

    // ── process 2: recovers from the same database ──
    peer.behaviour = { workingPolls: 1 };
    const store2 = new SqliteStore(path, { sanitize: (v) => redactor.redact(v).value });
    const remote2 = new A2aPeerExecutor(peerConfig({ ...config, poll: { initialDelayMs: 10, maxDelayMs: 50, multiplier: 1.5 } }), {
      resolver: new AgentCardResolver(),
      ledger: store2,
    });
    const local2 = new ScriptedExecutor({ id: 'dsh-local', clock: systemClock, script: [{ kind: 'answer', answer: '42', latencyMs: 10 }] });
    const engine2 = engineOn(store2, local2, [remote2]);
    const report = await engine2.recover();
    expect(report).toMatchObject({ tasks: 2, resumed: 1, failed: 1 });

    const remoteState = await engine2.waitForTerminal(remoteTask);
    expect(remoteState.outcome).toMatchObject({ status: 'succeeded', verificationStatus: 'verified' });
    expect(peer.callsOf('SendMessage')).toHaveLength(1); // resumed by polling, never resent

    const localState = await engine2.waitForTerminal(localTask);
    expect(localState.outcome).toMatchObject({ status: 'succeeded', verificationStatus: 'verified' });
    const locals = attemptsOf(localState).filter((a) => a.executorKind === 'dsh-local');
    expect(locals).toHaveLength(2);
    expect(locals[0]!.result!.diagnostics[0]!.code).toBe('orphaned_on_restart');
    expect(locals[1]!.attemptId).not.toBe(locals[0]!.attemptId);

    const events = await store2.events(remoteTask);
    expect(isTerminalPhase(remoteState.phase)).toBe(true);
    expect(events.filter((e) => e.type === 'attempt.remote_submitted')).toHaveLength(1);
    await store2.close();
  });
});
