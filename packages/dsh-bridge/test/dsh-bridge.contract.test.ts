import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttemptId, type ExecutionRequest, SecretValue, systemClock, toIso } from '@dvo/core';
import {
  DshExecutor,
  type DshRuntimeLock,
  LineSplitter,
  mapHeadlessRun,
  parseHeadlessLine,
  parseVersion,
  profileDigest,
} from '@dvo/dsh-bridge';
import { correlation, fakeDshCommand } from '@dvo/testkit';

let dir = '';
let patch = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dvo-dsh-'));
  patch = join(dir, 'dvo-headless.patch.yml');
  await writeFile(patch, '- id: approval\n  config:\n    policy: never\n');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function lock(overrides: Partial<DshRuntimeLock> = {}): DshRuntimeLock {
  return {
    command: fakeDshCommand(),
    expectedVersion: '0.2.0-rc.1',
    commit: '4878cdabd87d4041bdaff61d04c966883b9fd07a',
    profile: 'headless',
    patchFiles: [patch],
    modelRoute: 'deepseek/test',
    toolAllowlist: ['read_file'],
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    envAllowlist: ['PATH', 'HOME', 'FAKE_DSH_SCENARIO', 'FAKE_DSH_ANSWER', 'FAKE_DSH_VERSION'],
    versionArgs: ['--version'],
    enforceVersion: true,
    workdir: dir,
    maxFinalBytes: 256 * 1024,
    killGraceMs: 300,
    ...overrides,
  };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    correlation: correlation({ attemptId: AttemptId('att_dsh') }),
    prompt: 'What is six times seven?',
    budget: { maxInputTokens: 100_000, maxOutputTokens: 10_000, deadlineAt: toIso(Date.now() + 30_000) },
    requestedTier: 1,
    classification: 'internal',
    ...overrides,
  };
}

async function run(
  scenario: string,
  overrides: Partial<DshRuntimeLock> = {},
  req: Partial<ExecutionRequest> = {},
  extraEnv: Record<string, string> = {},
) {
  process.env['FAKE_DSH_SCENARIO'] = scenario;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  try {
    const executor = new DshExecutor({ lock: lock(overrides), clock: systemClock });
    const handle = await executor.start(request(req));
    return { executor, handle, result: handle.result() };
  } finally {
    delete process.env['FAKE_DSH_SCENARIO'];
    for (const k of Object.keys(extraEnv)) delete process.env[k];
  }
}

describe('DshExecutor contract (design §8.3)', () => {
  it('success: normalises the final answer into an EvidenceEnvelope with usage, cost and runtime provenance', async () => {
    const { result } = await run('success');
    const r = await result;
    expect(r.terminalStatus).toBe('completed');
    expect(r.output!.claims[0]).toMatchObject({ id: 'answer', statement: '42' });
    expect(r.output!.correlation.attemptId).toBe('att_dsh');
    expect(r.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, costUsd: 0.0018 });
    expect(r.runtime).toMatchObject({
      name: 'deepseek-harness',
      version: '0.2.0-rc.1',
      commit: '4878cdabd87d4041bdaff61d04c966883b9fd07a',
    });
    expect(r.runtime!.profileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('delivers the prompt over stdin, never argv', async () => {
    const r = await (await run('success')).result;
    const bytes = Number(r.output!.claims[0]!.assumptions[0]!.split(':')[1]);
    expect(bytes).toBeGreaterThan('What is six times seven?'.length); // prompt + response contract
  });

  it('structured-output failure → invalid_output (retryable)', async () => {
    const r = await (await run('invalid_output')).result;
    expect(r.terminalStatus).toBe('invalid_output');
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'structured_output_invalid', retryable: true }));
  });

  it('subagent crash → failed subagent_crashed (retryable)', async () => {
    const r = await (await run('crash')).result;
    expect(r.terminalStatus).toBe('failed');
    expect(r.diagnostics[0]).toMatchObject({ code: 'subagent_crashed', retryable: true });
  });

  it('refusal, token ceiling and runtime error map to distinct outcomes', async () => {
    expect((await (await run('refusal')).result).terminalStatus).toBe('refused');
    expect((await (await run('max_tokens')).result).diagnostics[0]!.code).toBe('max_tokens');
    const error = await (await run('error_event')).result;
    expect(error.diagnostics[0]).toMatchObject({ code: 'dsh_provider_error', retryable: true });
    expect((await (await run('no_final')).result).diagnostics[0]!.code).toBe('subagent_crashed');
  });

  it('structured turn-end errors (real DSH 0.2.0-rc.1 shape) keep their code; config faults are not retried', async () => {
    const r = await (await run('missing_credential')).result;
    expect(r.terminalStatus).toBe('failed');
    expect(r.diagnostics[0]).toMatchObject({ code: 'dsh_missing_credential', retryable: false });
    expect(r.diagnostics[0]!.safeMessage).toContain('no API key');
  });

  it('cancel kills the process group → cancelled', async () => {
    const { handle, result } = await run('hang');
    await new Promise((r) => setTimeout(r, 300));
    await handle.cancel('test');
    expect((await result).terminalStatus).toBe('cancelled');
  });

  it('escalates SIGTERM to SIGKILL for a child that ignores it', async () => {
    const { handle, result } = await run('ignore_sigterm');
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await handle.cancel('test');
    expect((await result).terminalStatus).toBe('cancelled');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('timeout: the attempt deadline kills the child → timed_out', async () => {
    const r = await (
      await run('hang', {}, { budget: { maxInputTokens: 1e5, maxOutputTokens: 1e4, deadlineAt: toIso(Date.now() + 700) } })
    ).result;
    expect(r.terminalStatus).toBe('timed_out');
  });

  it('meters tokens and stops the run at the budget', async () => {
    const r = await (await run('over_budget')).result;
    expect(r.terminalStatus).toBe('failed');
    expect(r.diagnostics[0]!.code).toBe('token_budget_exceeded');
  });

  it('never stores raw reasoning', async () => {
    const r = await (await run('thinking_secret')).result;
    expect(r.terminalStatus).toBe('completed');
    expect(JSON.stringify(r)).not.toContain('THISMUSTNEVERBESTORED');
  });

  it('rebuilds the child environment from an allowlist and injects credentials', async () => {
    const secrets = { resolve: async () => new SecretValue('dsk-test-credential') };
    process.env['FAKE_DSH_SCENARIO'] = 'env_keys';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'must-not-leak';
    try {
      const executor = new DshExecutor({
        lock: lock({ credentialEnv: [{ name: 'DEEPSEEK_API_KEY', ref: 'secret://dsh/key' }] }),
        secrets,
        clock: systemClock,
      });
      const r = await (await executor.start(request())).result();
      const keys = r.output!.claims[0]!.statement.split(',');
      expect(keys).toContain('DEEPSEEK_API_KEY');
      expect(keys).toContain('DSH_PERMISSION_MODE');
      expect(keys).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(JSON.stringify(r)).not.toContain('dsk-test-credential');
    } finally {
      delete process.env['FAKE_DSH_SCENARIO'];
      delete process.env['AWS_SECRET_ACCESS_KEY'];
    }
  });

  it('refuses to run a runtime whose version differs from the lock', async () => {
    process.env['FAKE_DSH_VERSION'] = '0.3.0';
    try {
      const executor = new DshExecutor({ lock: lock(), clock: systemClock });
      const caps = await executor.capabilities();
      expect(caps.available).toBe(false);
      expect(caps.degradedReason).toMatch(/does not match lock/);
      const r = await (await executor.start(request())).result();
      expect(r.diagnostics[0]!.code).toBe('runtime_unavailable');
    } finally {
      delete process.env['FAKE_DSH_VERSION'];
    }
  });

  it('reports a missing launcher or patch as unavailable', async () => {
    expect((await new DshExecutor({ lock: lock({ command: ['/nonexistent/dsh'] }) }).capabilities()).available).toBe(false);
    expect((await new DshExecutor({ lock: lock({ patchFiles: ['/nonexistent.yml'] }) }).capabilities()).degradedReason).toMatch(/patch/);
  });
});

describe('headless protocol helpers', () => {
  it('parses known events and ignores unknown ones', () => {
    expect(parseHeadlessLine('{"type":"status","phase":"step_end","usage":{"inputTokens":1,"outputTokens":2}}')).toEqual({
      type: 'status',
      phase: 'step_end',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(parseHeadlessLine('{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"message":"m","code":"C"}}}')).toEqual({
      type: 'status',
      phase: 'turn_end',
      reason: 'error',
      error: { message: 'm', code: 'C' },
    });
    expect(parseHeadlessLine('{"type":"future_event"}')).toBeUndefined();
    expect(parseHeadlessLine('not json')).toBeUndefined();
  });

  it('splits lines across chunks and refuses oversized ones', () => {
    const lines: string[] = [];
    let oversized = 0;
    const s = new LineSplitter(10);
    s.push(
      'ab',
      (l) => lines.push(l),
      () => oversized++,
    );
    s.push(
      'c\n0123456789ABC',
      (l) => lines.push(l),
      () => oversized++,
    );
    s.push(
      'DEF\nok\n',
      (l) => lines.push(l),
      () => oversized++,
    );
    expect(lines).toEqual(['abc', 'ok']);
    expect(oversized).toBe(1);
  });

  it('maps run observations to terminal statuses', () => {
    const base = {
      exitCode: 0,
      signal: null,
      sessionSeen: true,
      finalOversized: false,
      inputTokens: 0,
      outputTokens: 0,
      usageComplete: true,
      toolCalls: 0,
      malformedLines: 0,
      stderrTail: '',
    };
    expect(mapHeadlessRun({ ...base, turnEndReason: 'completed', finalText: 'x' }).status).toBe('completed');
    expect(mapHeadlessRun({ ...base, killedBy: 'cancelled', turnEndReason: 'completed', finalText: 'x' }).diagnostics[0]!.code).toBe(
      'completed_after_cancel',
    );
    expect(mapHeadlessRun({ ...base, spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }).diagnostics[0]).toMatchObject({
      code: 'runtime_unavailable',
      retryable: false,
    });
    expect(mapHeadlessRun({ ...base, exitCode: 1, turnEndReason: 'aborted' }).diagnostics[0]!.code).toBe('aborted');
  });

  it('parses versions and digests the profile deterministically', async () => {
    expect(parseVersion('dsh 0.2.0-rc.1\n')).toBe('0.2.0-rc.1');
    expect(parseVersion('no version')).toBeUndefined();
    expect(await profileDigest(lock())).toBe(await profileDigest(lock({ toolAllowlist: ['read_file'] })));
    expect(await profileDigest(lock())).not.toBe(await profileDigest(lock({ modelRoute: 'other' })));
  });
});
