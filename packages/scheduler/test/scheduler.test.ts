import { describe, expect, it } from 'vitest';
import { AttemptId, HarnessError, type ExecutionRequest, TaskId } from '@dvo/core';
import { AttemptScheduler, backoffDelay, CircuitBreaker, retry, Semaphore } from '@dvo/scheduler';
import { correlation, FakeClock, flush, ScriptedExecutor } from '@dvo/testkit';

const request = (id: string, deadlineAt = '2026-01-01T01:00:00.000Z'): ExecutionRequest => ({
  correlation: correlation({ attemptId: AttemptId(id), idempotencyKey: id }),
  prompt: 'p',
  budget: { maxInputTokens: 1000, maxOutputTokens: 1000, deadlineAt },
  requestedTier: 1,
  classification: 'public',
});

describe('Semaphore', () => {
  it('is FIFO and releases once per permit', async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const r1 = await s.acquire();
    const p2 = s.acquire().then((r) => (order.push(2), r));
    const p3 = s.acquire().then((r) => (order.push(3), r));
    expect(s.waiting).toBe(2);
    r1();
    r1(); // idempotent
    (await p2)();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(s.available).toBe(1);
  });

  it('aborted waits leave the queue', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    const controller = new AbortController();
    const waiting = s.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(s.waiting).toBe(0);
    held();
    expect(s.available).toBe(1);
  });
});

describe('retry', () => {
  it('retries retryable errors with backoff and stops on the rest', async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const op = retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HarnessError('timeout', 't', { retryable: true });
        return 'ok';
      },
      { policy: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' }, clock },
    );
    await expect(clock.runUntilSettled(op)).resolves.toBe('ok');
    expect(calls).toBe(3);

    let fatal = 0;
    await expect(
      retry(
        async () => {
          fatal += 1;
          throw new HarnessError('validation_failed', 'no');
        },
        { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' }, clock },
      ),
    ).rejects.toThrow('no');
    expect(fatal).toBe(1);
  });

  it('backoff is capped and jitter stays in range', () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1000, jitter: 'full' as const };
    for (let i = 1; i < 10; i++) {
      const d = backoffDelay(i, policy);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
    expect(backoffDelay(3, { ...policy, jitter: 'none' })).toBe(400);
  });
});

describe('CircuitBreaker', () => {
  it('opens after consecutive failures, half-opens after cooldown, closes on a good probe', async () => {
    const clock = new FakeClock(0);
    const changes: string[] = [];
    const b = new CircuitBreaker(
      'peer',
      { failureThreshold: 2, cooldownMs: 1000, halfOpenMaxProbes: 1, successThreshold: 1 },
      clock,
      (_id, from, to) => changes.push(`${from}->${to}`),
    );
    b.onFailure();
    expect(b.state).toBe('closed');
    b.onFailure();
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    await clock.advance(1000);
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // one probe at a time
    b.onSuccess();
    expect(b.state).toBe('closed');
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('a manual trip stays open until reset', async () => {
    const clock = new FakeClock(0);
    const b = new CircuitBreaker('peer', { failureThreshold: 1, cooldownMs: 10, halfOpenMaxProbes: 1, successThreshold: 1 }, clock);
    b.trip();
    await clock.advance(1000);
    expect(b.state).toBe('open');
    b.reset();
    expect(b.state).toBe('closed');
  });
});

describe('AttemptScheduler', () => {
  const make = (clock: FakeClock, perExecutor = 2) =>
    new AttemptScheduler({ clock, globalConcurrency: 4, executorConcurrency: () => perExecutor, cancelGraceMs: 1000 });

  it('returns the executor result and releases permits', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
    const scheduler = make(clock);
    const exec = new ScriptedExecutor({ id: 'e', clock, script: [{ kind: 'answer', answer: '42', latencyMs: 10 }] });
    const managed = scheduler.launch({
      taskId: TaskId('t'),
      attemptId: AttemptId('a1'),
      executor: exec,
      request: request('a1'),
      deadlineMs: clock.now() + 60_000,
    });
    const result = await clock.runUntilSettled(managed.result);
    expect(result.terminalStatus).toBe('completed');
    expect(scheduler.activeCount).toBe(0);
  });

  it('turns a deadline into cancel, then timed_out', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
    const scheduler = make(clock);
    const exec = new ScriptedExecutor({ id: 'e', clock, script: [{ kind: 'hang' }] });
    const managed = scheduler.launch({
      taskId: TaskId('t'),
      attemptId: AttemptId('a1'),
      executor: exec,
      request: request('a1'),
      deadlineMs: clock.now() + 500,
    });
    const result = await clock.runUntilSettled(managed.result);
    expect(result.terminalStatus).toBe('timed_out');
    expect(result.diagnostics.map((d) => d.code)).toContain('deadline_exceeded');
    expect(exec.cancelled).toEqual(['a1']);
  });

  it('synthesises a result when an executor ignores cancellation', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
    const scheduler = make(clock);
    const deaf = {
      id: 'deaf',
      kind: 'dsh-local' as const,
      capabilities: async () => ({
        kind: 'dsh-local' as const,
        skills: [],
        maxEvidenceTier: 0 as const,
        supportsCancel: false,
        supportsResume: false,
        supportsIdempotentResubmit: false,
        available: true,
      }),
      start: async () => ({ attemptId: AttemptId('a1'), cancel: async () => undefined, result: () => new Promise<never>(() => undefined) }),
    };
    const managed = scheduler.launch({
      taskId: TaskId('t'),
      attemptId: AttemptId('a1'),
      executor: deaf,
      request: request('a1'),
      deadlineMs: clock.now() + 60_000,
    });
    await flush();
    managed.cancel('user');
    const result = await clock.runUntilSettled(managed.result);
    expect(result.terminalStatus).toBe('cancelled');
    expect(result.diagnostics[0]!.code).toBe('cancel_unconfirmed');
  });

  it('bounds concurrency per executor and cancels queued work without starting it', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
    const scheduler = make(clock, 1);
    const exec = new ScriptedExecutor({ id: 'e', clock, script: [{ kind: 'answer', answer: '1', latencyMs: 100 }] });
    const first = scheduler.launch({
      taskId: TaskId('t'),
      attemptId: AttemptId('a1'),
      executor: exec,
      request: request('a1'),
      deadlineMs: clock.now() + 60_000,
    });
    const second = scheduler.launch({
      taskId: TaskId('t'),
      attemptId: AttemptId('a2'),
      executor: exec,
      request: request('a2'),
      deadlineMs: clock.now() + 60_000,
    });
    await flush();
    expect(exec.calls).toBe(1);
    second.cancel('no longer needed');
    const r2 = await clock.runUntilSettled(second.result);
    expect(r2.diagnostics[0]!.code).toBe('cancelled_before_start');
    await clock.runUntilSettled(first.result);
    expect(exec.calls).toBe(1);
  });

  it('refuses to start when the circuit is open and normalises start failures', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
    const scheduler = make(clock);
    const breaker = new CircuitBreaker('e', { failureThreshold: 1, cooldownMs: 1000, halfOpenMaxProbes: 1, successThreshold: 1 }, clock);
    const exec = new ScriptedExecutor({ id: 'e', clock, script: [{ kind: 'throw', message: 'boom' }] });
    const first = await clock.runUntilSettled(
      scheduler.launch({
        taskId: TaskId('t'),
        attemptId: AttemptId('a1'),
        executor: exec,
        request: request('a1'),
        deadlineMs: clock.now() + 60_000,
        breaker,
      }).result,
    );
    expect(first.terminalStatus).toBe('failed');
    expect(breaker.state).toBe('open');
    const second = await clock.runUntilSettled(
      scheduler.launch({
        taskId: TaskId('t'),
        attemptId: AttemptId('a2'),
        executor: exec,
        request: request('a2'),
        deadlineMs: clock.now() + 60_000,
        breaker,
      }).result,
    );
    expect(second.diagnostics[0]!.code).toBe('circuit_open');
    expect(exec.calls).toBe(1);
  });

  it('launching the same attempt twice returns the same run', () => {
    const clock = new FakeClock(0);
    const scheduler = make(clock);
    const exec = new ScriptedExecutor({ id: 'e', clock, script: [{ kind: 'hang' }] });
    const spec = { taskId: TaskId('t'), attemptId: AttemptId('a1'), executor: exec, request: request('a1'), deadlineMs: 60_000 };
    expect(scheduler.launch(spec)).toBe(scheduler.launch(spec));
  });
});
