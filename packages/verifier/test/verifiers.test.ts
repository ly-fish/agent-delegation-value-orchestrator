import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttemptId } from '@dvo/core';
import { QuarantineStore } from '@dvo/evidence';
import {
  ArtifactDigestVerifier,
  CommandVerifier,
  ExactAnswerVerifier,
  matches,
  readVerification,
  RegexVerifier,
  VerifierExecutor,
  VerifierRegistry,
} from '@dvo/verifier';
import { correlation, envelope } from '@dvo/testkit';

const input = (answer: string, params: Record<string, unknown> = {}) => ({
  correlation: correlation(),
  candidate: envelope(answer),
  spec: { verifierId: 'x', params },
});
const signal = new AbortController().signal;

describe('ExactAnswerVerifier', () => {
  const v = new ExactAnswerVerifier();

  it('compares numbers with tolerance and text after normalisation', async () => {
    expect((await v.verify(input('42.0', { expected: 42 }))).outcome).toBe('verified');
    expect((await v.verify(input('3.14159', { expected: 3.1416, tolerance: 1e-4 }))).outcome).toBe('verified');
    expect((await v.verify(input('41', { expected: 42 }))).outcome).toBe('refuted');
    expect((await v.verify(input('Paris.', { expected: 'paris' }))).outcome).toBe('verified');
    expect(matches('Paris', 'paris', 0, true)).toBe(false);
  });

  it('refutes a missing claim and requires a locally held expected value', async () => {
    expect((await v.verify({ ...input('1', { expected: 1 }), candidate: { ...envelope('1'), claims: [] } })).outcome).toBe('refuted');
    await expect(v.verify(input('1'))).rejects.toThrow(/params.expected/);
  });
});

describe('RegexVerifier', () => {
  it('matches the configured pattern only', async () => {
    const v = new RegexVerifier('iso-date', '^\\d{4}-\\d{2}-\\d{2}$');
    expect((await v.verify(input('2026-09-29'))).outcome).toBe('verified');
    expect((await v.verify(input('29/09/2026'))).outcome).toBe('refuted');
    expect(() => new RegexVerifier('long', 'a'.repeat(600))).toThrow(/too long/);
  });
});

describe('CommandVerifier (isolated, credential-free)', () => {
  const script = (code: string) => [process.execPath, '-e', code, '{input}'];

  it('verifies when the check exits 0 and passes the candidate as a file', async () => {
    const v = new CommandVerifier('node-check', {
      command: script("const fs=require('fs');process.exit(fs.readFileSync(process.argv[1],'utf8').trim()==='42'?0:1)"),
      timeoutMs: 10_000,
    });
    expect((await v.verify(input('42'), signal)).outcome).toBe('verified');
    expect((await v.verify(input('41'), signal)).outcome).toBe('refuted');
  });

  it('does not inherit credentials from the environment', async () => {
    process.env['DVO_TEST_SECRET'] = 'hunter2';
    try {
      const v = new CommandVerifier('env-check', {
        command: script('process.exit(process.env.DVO_TEST_SECRET ? 1 : 0)'),
        timeoutMs: 10_000,
      });
      expect((await v.verify(input('x'), signal)).outcome).toBe('verified');
    } finally {
      delete process.env['DVO_TEST_SECRET'];
    }
  });

  it('kills a check that exceeds its timeout', async () => {
    const v = new CommandVerifier('slow', { command: script('setTimeout(()=>{},60000)'), timeoutMs: 200 });
    const outcome = await v.verify(input('x'), signal);
    expect(outcome.outcome).toBe('refuted');
    expect(outcome.detail).toMatch(/timeout|exit/);
  });
});

describe('ArtifactDigestVerifier', () => {
  it('verifies quarantined artifacts against declared digests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dvo-v-'));
    try {
      const store = new QuarantineStore(dir);
      const { sha256 } = await store.put(Buffer.from('payload'));
      const v = new ArtifactDigestVerifier(store);
      const withArtifact = (sha: string) => ({
        ...input('x'),
        candidate: { ...envelope('x'), evidence: [{ kind: 'artifact' as const, summary: 'a', sha256: sha }] },
      });
      expect((await v.verify(withArtifact(sha256))).outcome).toBe('verified');
      expect((await v.verify(withArtifact('0'.repeat(64)))).outcome).toBe('inconclusive');
      expect((await v.verify(input('x'))).outcome).toBe('inconclusive');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('VerifierExecutor and registry', () => {
  it('produces the only envelopes allowed to carry verified claims', async () => {
    const exec = new VerifierExecutor(new ExactAnswerVerifier());
    const handle = await exec.start({
      correlation: correlation({ attemptId: AttemptId('att_v') }),
      prompt: '',
      budget: { maxInputTokens: 0, maxOutputTokens: 0, deadlineAt: '2026-01-01T00:10:00.000Z' },
      requestedTier: 2,
      classification: 'public',
      verification: {
        targetAttemptId: AttemptId('att_t'),
        candidate: envelope('42'),
        spec: { verifierId: 'exact-answer', params: { expected: '42' } },
      },
    });
    const result = await handle.result();
    expect(result.terminalStatus).toBe('completed');
    expect(readVerification(result.output)).toMatchObject({
      outcome: 'verified',
      claimVerdicts: [{ claimId: 'answer', verdict: 'verified' }],
    });
  });

  it('reports verifier errors as retryable failures', async () => {
    const exec = new VerifierExecutor(new ExactAnswerVerifier());
    const handle = await exec.start({
      correlation: correlation(),
      prompt: '',
      budget: { maxInputTokens: 0, maxOutputTokens: 0, deadlineAt: '2026-01-01T00:10:00.000Z' },
      requestedTier: 2,
      classification: 'public',
      verification: { targetAttemptId: AttemptId('att_t'), candidate: envelope('42'), spec: { verifierId: 'exact-answer' } },
    });
    expect((await handle.result()).terminalStatus).toBe('failed');
  });

  it('registry exposes health views and refuses duplicates', async () => {
    const registry = new VerifierRegistry([new ExactAnswerVerifier()]);
    expect(await registry.views()).toEqual([{ id: 'exact-answer', deterministic: true, available: true }]);
    expect(() => registry.register(new ExactAnswerVerifier())).toThrow(/twice/);
    expect(registry.executor('exact-answer')!.id).toBe('verifier:exact-answer');
  });
});
