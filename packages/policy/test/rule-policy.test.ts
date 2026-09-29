import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@dvo/core';
import {
  ConfidenceGatedPolicy,
  DvoRulePolicy,
  FixedTopologyPolicy,
  LocalOnlyPolicy,
  policyConfig,
  successProbability,
  whyNotDelegate,
} from '@dvo/policy';
import { input, peer, result } from './fixtures.ts';

const policy = new DvoRulePolicy();
const blocksOf = (decision: ReturnType<DvoRulePolicy['decide']>, kind: string, peerId?: string) =>
  decision.candidates.find((c) => c.action.kind === kind && (peerId === undefined || ('peerId' in c.action && c.action.peerId === peerId)))
    ?.blockedBy ?? [];

describe('value model', () => {
  it('a verifier lets any correct candidate count; without one only the best does', () => {
    expect(successProbability([0.5, 0.5], 1)).toBeCloseTo(0.75);
    expect(successProbability([0.5, 0.5], 0)).toBeCloseTo(0.5);
    expect(successProbability([], 1)).toBe(0);
  });
});

describe('DvoRulePolicy: hard limits first (design §7.1)', () => {
  it('stops at the deadline and when the budget is exhausted', () => {
    expect(policy.decide(input({ remainingMs: 0 })).selected).toEqual({ kind: 'stop', reason: 'deadline' });
    expect(policy.decide(input({ spent: { costUsd: 1, inputTokens: 0, outputTokens: 0, remoteCalls: 0 } })).selected).toEqual({
      kind: 'stop',
      reason: 'budget',
    });
  });

  it('stops with sufficient evidence once something is verified', () => {
    const d = policy.decide(input({ results: [result('a', { verification: 'verified' })] }));
    expect(d.selected).toEqual({ kind: 'stop', reason: 'sufficient_evidence' });
  });

  it('verifies unverified output before anything else', () => {
    const d = policy.decide(
      input({
        verifierId: 'exact',
        verifiers: [{ id: 'exact', deterministic: true, available: true }],
        results: [result('a')],
        peers: [peer('p1')],
      }),
    );
    expect(d.selected).toEqual({ kind: 'verify', verifierId: 'exact', targetAttemptIds: ['a'] });
  });
});

describe('DvoRulePolicy: value gating', () => {
  it('runs locally first when the peer is not demonstrably better', () => {
    const d = policy.decide(input({ peers: [peer('p1', { reliability: { mean: 0.5, lcb: 0.1, n: 0 } })] }));
    expect(d.selected.kind).toBe('continue_local');
    const local = d.candidates.find((c) => c.action.kind === 'continue_local')!;
    const delegate = d.candidates.find((c) => c.action.kind === 'delegate')!;
    expect(delegate.netValue).toBeLessThan(local.netValue);
    expect(d.reason).toMatch(/runner-up delegate/);
  });

  it('delegates when the peer lower bound beats the local estimate', () => {
    const d = policy.decide(input({ local: { ...input().local!, reliability: { mean: 0.2, lcb: 0.1, n: 30 } }, peers: [peer('p1')] }));
    expect(d.selected).toMatchObject({ kind: 'delegate', peerId: 'p1' });
    expect(d.reason).toMatch(/LCB gain/);
  });

  it('escalates after a refuted local answer (verifiable task)', () => {
    const d = policy.decide(
      input({
        verifierId: 'exact',
        verifiers: [{ id: 'exact', deterministic: true, available: true }],
        results: [result('a', { verification: 'refuted' })],
        local: { ...input().local!, attemptsSoFar: 1 },
        peers: [peer('p1')],
      }),
    );
    expect(d.selected).toMatchObject({ kind: 'delegate', peerId: 'p1', evidenceTier: 2 });
  });

  it('stops with the current answer when escalation is not worth it', () => {
    const d = policy.decide(
      input({
        results: [result('a', { calibratedConfidence: 0.7 })],
        local: { ...input().local!, attemptsSoFar: 1 },
        peers: [peer('p1', { reliability: { mean: 0.6, lcb: 0.3, n: 5 } })],
      }),
    );
    expect(d.selected).toEqual({ kind: 'stop', reason: 'sufficient_evidence' });
    expect(d.reason).toMatch(/delegation not taken/);
  });

  it('uses parallel solves only for weakly coupled tasks', () => {
    const peers = [
      peer('p1', { reliability: { mean: 0.7, lcb: 0.55, n: 40 } }),
      peer('p2', { reliability: { mean: 0.7, lcb: 0.55, n: 40 } }),
    ];
    const verifiable = { verifierId: 'exact', verifiers: [{ id: 'exact', deterministic: true, available: true }] };
    const weakLocal = { ...input().local!, reliability: { mean: 0.1, lcb: 0.05, n: 30 } };
    const loose = policy.decide(
      input({ ...verifiable, local: weakLocal, peers, hardness: { ...input().hardness, dependencyCoupling: 0.2 } }),
    );
    expect(loose.selected).toMatchObject({ kind: 'parallel', peerIds: ['p1', 'p2'] });
    const coupled = policy.decide(
      input({ ...verifiable, local: weakLocal, peers, hardness: { ...input().hardness, dependencyCoupling: 0.6 } }),
    );
    expect(coupled.selected.kind).toBe('delegate');
    expect(blocksOf(coupled, 'parallel')).toContain('not_decomposable');
  });

  it('requests higher-tier evidence when unverifiable answers conflict', () => {
    const d = policy.decide(
      input({
        results: [
          result('a', { calibratedConfidence: 0.55 }),
          result('b', {
            executorId: 'p1',
            executorKind: 'a2a-peer',
            peerId: peer('p1').peerId,
            calibratedConfidence: 0.6,
            tier: 0,
            claimDigests: { answer: 'digest-b' },
          }),
        ],
        local: { ...input().local!, attemptsSoFar: 1 },
        peers: [peer('p1', { attemptsSoFar: 1 })],
      }),
    );
    expect(d.selected).toMatchObject({ kind: 'request_evidence', attemptId: 'b', nextTier: 1 });
  });
});

describe('DvoRulePolicy: safety gates', () => {
  it('keeps restricted data local unless the peer is cleared and a human approved', () => {
    const weakLocal = { ...input().local!, reliability: { mean: 0.1, lcb: 0.05, n: 30 } };
    const cleared = peer('p1', { trustTier: 'restricted', allowRestricted: true });
    const d1 = policy.decide(input({ classification: 'restricted', local: weakLocal, peers: [peer('p0'), cleared] }));
    expect(d1.selected.kind).toBe('continue_local');
    expect(blocksOf(d1, 'delegate', 'p0')).toContain('classification');
    expect(blocksOf(d1, 'delegate', 'p1')).toContain('approval_required');
    const d2 = policy.decide(
      input({ classification: 'restricted', restrictedDelegationApproved: true, local: weakLocal, peers: [cleared] }),
    );
    expect(d2.selected).toMatchObject({ kind: 'delegate', peerId: 'p1' });
  });

  it('never delegates secret data, to open circuits, beyond the remote-call budget or without the skill', () => {
    const weakLocal = { ...input().local!, reliability: { mean: 0.1, lcb: 0.05, n: 30 } };
    expect(blocksOf(policy.decide(input({ classification: 'secret', local: weakLocal, peers: [peer('p1')] })), 'delegate')).toContain(
      'classification',
    );
    expect(blocksOf(policy.decide(input({ local: weakLocal, peers: [peer('p1', { circuit: 'open' })] })), 'delegate')).toContain(
      'circuit_open',
    );
    expect(
      blocksOf(
        policy.decide(input({ local: weakLocal, peers: [peer('p1')], budget: { ...input().budget, maxRemoteCalls: 0 } })),
        'delegate',
      ),
    ).toContain('budget_remote_calls');
    expect(
      blocksOf(policy.decide(input({ local: weakLocal, requiredSkills: ['code-review'], peers: [peer('p1')] })), 'delegate'),
    ).toContain('skill_mismatch');
    expect(
      blocksOf(policy.decide(input({ local: weakLocal, remainingMs: 3000, peers: [peer('p1', { estLatencyMs: 1000 })] })), 'delegate'),
    ).toContain('deadline_window');
  });

  it('explains why nothing was delegated', () => {
    const d = policy.decide(input({ allowRemote: false, peers: [peer('p1')] }));
    expect(whyNotDelegate(d.candidates.filter((c) => c.action.kind === 'delegate'))).toContain('remote_disallowed (p1)');
  });
});

describe('determinism and exploration', () => {
  it('is a pure function of its input', () => {
    const i = input({ peers: [peer('p1'), peer('p2')] });
    expect(canonicalJson(policy.decide(i))).toBe(canonicalJson(policy.decide(structuredClone(i))));
  });

  it('explores reproducibly and records propensities only for safe, verifiable public tasks', () => {
    const explorer = new DvoRulePolicy(policyConfig({ exploration: { enabled: true, epsilon: 1, seed: 7 } }));
    const safe = input({
      classification: 'public',
      safeForExploration: true,
      verifierId: 'exact',
      verifiers: [{ id: 'exact', deterministic: true, available: false }],
      local: { ...input().local!, reliability: { mean: 0.2, lcb: 0.1, n: 30 } },
      peers: [peer('p1'), peer('p2')],
    });
    const a = explorer.decide(safe);
    const b = explorer.decide(safe);
    expect(canonicalJson(a.selected)).toBe(canonicalJson(b.selected));
    expect(a.propensity).toBeGreaterThan(0);
    expect(a.propensity).toBeLessThanOrEqual(1);
    const unsafe = explorer.decide({ ...safe, classification: 'internal' });
    expect(unsafe.propensity).toBe(1);
    expect(unsafe.explored).toBe(false);
  });
});

describe('baselines obey the same hard limits', () => {
  const weakLocal = { ...input().local!, reliability: { mean: 0.1, lcb: 0.05, n: 30 } };

  it('local-only never delegates', () => {
    const d = new LocalOnlyPolicy().decide(input({ local: weakLocal, peers: [peer('p1')] }));
    expect(d.selected.kind).toBe('continue_local');
    const done = new LocalOnlyPolicy().decide(
      input({ results: [result('a')], local: { ...weakLocal, attemptsSoFar: 1 }, peers: [peer('p1')] }),
    );
    expect(done.selected.kind).toBe('stop');
  });

  it('fixed topology fans out to all permitted peers first', () => {
    const d = new FixedTopologyPolicy().decide(input({ peers: [peer('p1'), peer('p2')] }));
    expect(d.selected).toMatchObject({ kind: 'parallel' });
    const restricted = new FixedTopologyPolicy().decide(input({ classification: 'restricted', peers: [peer('p1'), peer('p2')] }));
    expect(restricted.selected.kind).toBe('continue_local');
  });

  it('confidence gating delegates on low self-reported confidence', () => {
    const gated = new ConfidenceGatedPolicy(0.7);
    expect(gated.decide(input({ peers: [peer('p1')] })).selected.kind).toBe('continue_local');
    const low = gated.decide(
      input({ results: [result('a', { calibratedConfidence: 0.4 })], local: { ...weakLocal, attemptsSoFar: 1 }, peers: [peer('p1')] }),
    );
    expect(low.selected).toMatchObject({ kind: 'delegate', peerId: 'p1' });
  });
});
