import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@dvo/trace';
import { Redactor } from '@dvo/evidence';
import { buildApp, createPino, createServer, EnvFileSecretProvider, loadConfig, toCoreLogger, type App } from '@dvo/service';
import { fakeDshCommand } from '@dvo/testkit';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dvo-svc-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('configuration', () => {
  it('loads the shipped example and demo configurations', () => {
    const examples = loadConfig(join(repo, 'configs'));
    expect(examples.peers[0]).toMatchObject({ id: 'research-peer-01', trustTier: 'internal', dedupSupported: false });
    expect(examples.lock.dsh).toMatchObject({ expectedVersion: '0.2.0-rc.1', profile: 'headless' });
    expect(examples.lock.dsh.patchFiles[0]).toMatch(/configs\/dsh\/dvo-headless\.patch\.yml$/);
    const demo = loadConfig(join(repo, 'configs/demo'));
    expect(demo.lock.dsh.command[1]).toMatch(/packages\/testkit\/bin\/fake-dsh\.mjs$/);
  });

  it('reports every invalid field', async () => {
    const bad = join(dir, 'bad');
    await mkdir(bad, { recursive: true });
    for (const name of ['service', 'policy', 'runtime-lock']) {
      await writeFile(
        join(bad, `${name}.yaml`),
        await (
          await import('node:fs/promises')
        ).readFile(join(repo, 'configs', name === 'runtime-lock' ? 'runtime-lock.yaml' : `${name}.example.yaml`), 'utf8'),
      );
    }
    await writeFile(
      join(bad, 'peers.yaml'),
      'peers:\n  - id: Bad Id\n    endpoint: not-a-url\n    allowed: yes-please\n    trustTier: galaxy\n',
    );
    expect(() => loadConfig(bad)).toThrow(/invalid configuration/);
    try {
      loadConfig(bad);
    } catch (error) {
      expect((error as { issues: string[] }).issues.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('EnvFileSecretProvider', () => {
  it('resolves from the environment, then from files, and refuses traversal', async () => {
    const secretsDir = join(dir, 'secrets');
    await mkdir(join(secretsDir, 'a2a'), { recursive: true });
    await writeFile(join(secretsDir, 'a2a', 'peer'), 'from-file\n');
    const provider = new EnvFileSecretProvider({ dir: secretsDir, env: { HARNESS_SECRET_ORCHESTRATOR_API_TOKEN: 'from-env' } });
    expect((await provider.resolve('secret://orchestrator/api-token')).reveal()).toBe('from-env');
    expect((await provider.resolve('secret://a2a/peer')).reveal()).toBe('from-file');
    await expect(provider.resolve('secret://a2a/../../etc/passwd')).rejects.toThrow(/traverse|malformed/);
    await expect(provider.resolve('https://example.com')).rejects.toThrow(/malformed/);
    await expect(provider.resolve('secret://missing/one')).rejects.toThrow(/could not be resolved/);
  });
});

describe('logging', () => {
  it('redacts credentials anywhere in a log line', () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()) });
    const logger = toCoreLogger(createPino('info', sink));
    logger.info({ note: 'key sk-' + 'Q'.repeat(30), headers: { authorization: 'Bearer abcdefghijklmnop' } }, 'hello');
    expect(lines.join('')).not.toContain('QQQQQQ');
    expect(lines.join('')).not.toContain('abcdefghijklmnop');
  });
});

describe('HTTP API', () => {
  let app: App;
  let http: Awaited<ReturnType<typeof createServer>>;
  const auth = { authorization: 'Bearer test-token' };

  beforeAll(async () => {
    const config = loadConfig(join(repo, 'configs/demo'));
    config.peers = [];
    config.service.http.apiTokenRef = 'secret://orchestrator/api-token';
    config.lock.dsh.command = fakeDshCommand();
    config.lock.dsh.workdir = dir;
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    const pino = createPino('warn', sink);
    app = await buildApp(config, toCoreLogger(pino), {
      store: new InMemoryStore({ sanitize: (v) => new Redactor().redact(v).value }),
      secrets: new EnvFileSecretProvider({ env: { HARNESS_SECRET_ORCHESTRATOR_API_TOKEN: 'test-token' } }),
    });
    http = await createServer(app, pino);
  });
  afterAll(async () => {
    await http.close();
    await app.close();
  });

  const waitForResult = async (taskId: string) => {
    for (let i = 0; i < 200; i++) {
      const res = await http.inject({ method: 'GET', url: `/v1/tasks/${taskId}/result`, headers: auth });
      if (res.statusCode === 200) return res.json<Record<string, unknown>>();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('task did not finish');
  };

  it('requires the bearer token on /v1 but not on health checks', async () => {
    expect((await http.inject({ method: 'GET', url: '/v1/tasks' })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/v1/tasks', headers: { authorization: 'Bearer wrong-token' } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    const ready = await http.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json<{ checks: { localRuntime: string } }>().checks.localRuntime).toBe('ok');
  });

  it('runs a task end to end and exposes result, events, decisions and replay', async () => {
    const submit = await http.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': 'k-1' },
      payload: { goal: 'What is 6 * 7?', verification: { verifierId: 'exact-answer', params: { expected: 42 } } },
    });
    expect(submit.statusCode).toBe(202);
    const { taskId } = submit.json<{ taskId: string }>();
    const result = await waitForResult(taskId);
    expect(result).toMatchObject({ status: 'succeeded', verificationStatus: 'verified', answer: { statement: '42' } });

    const again = await http.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': 'k-1' },
      payload: { goal: 'What is 6 * 7?' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ taskId: string; created: boolean }>()).toMatchObject({ taskId, created: false });

    const events = (await http.inject({ method: 'GET', url: `/v1/tasks/${taskId}/events`, headers: auth })).json<Array<{ type: string }>>();
    expect(events[0]!.type).toBe('task.created');
    const decisions = (await http.inject({ method: 'GET', url: `/v1/tasks/${taskId}/decisions`, headers: auth })).json<
      Array<{ selected: { kind: string } }>
    >();
    expect(decisions.map((d) => d.selected.kind)).toEqual(['continue_local', 'verify', 'stop']);
    const replay = (await http.inject({ method: 'GET', url: `/v1/tasks/${taskId}/replay`, headers: auth })).json<{
      projectionMatches: boolean;
    }>();
    expect(replay.projectionMatches).toBe(true);
    const view = (await http.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: auth })).json<{
      attempts: Array<{ runtime?: unknown; answer: string }>;
    }>();
    expect(view.attempts[0]!.answer).toBe('42');

    const metrics = await http.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('dvo_tasks_total{outcome="succeeded",verification="verified"} 1');
  });

  it('validates input and maps errors to status codes', async () => {
    const invalid = await http.inject({ method: 'POST', url: '/v1/tasks', headers: auth, payload: { goal: '', rogue: true } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ issues: string[] }>().issues.length).toBeGreaterThan(0);
    const unknownVerifier = await http.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: auth,
      payload: { goal: 'x', verification: { verifierId: 'nope' } },
    });
    expect(unknownVerifier.statusCode).toBe(400);
    const overBudget = await http.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: auth,
      payload: { goal: 'x', budget: { maxCostUsd: 1_000 } },
    });
    expect(overBudget.json<{ issues: string[] }>().issues.join()).toMatch(/exceeds the ceiling/);
    expect((await http.inject({ method: 'GET', url: '/v1/tasks/tsk_missing', headers: auth })).statusCode).toBe(404);
    expect((await http.inject({ method: 'POST', url: '/v1/peers/none/circuit/reset', headers: auth })).statusCode).toBe(404);
  });

  it('cancels a task', async () => {
    const submit = await http.inject({ method: 'POST', url: '/v1/tasks', headers: auth, payload: { goal: 'slow job' } });
    const { taskId } = submit.json<{ taskId: string }>();
    const cancel = await http.inject({ method: 'POST', url: `/v1/tasks/${taskId}/cancel`, headers: auth, payload: { reason: 'test' } });
    expect(cancel.statusCode).toBe(202);
    const result = await waitForResult(taskId);
    expect(['cancelled', 'succeeded']).toContain(result['status']);
  });
});
