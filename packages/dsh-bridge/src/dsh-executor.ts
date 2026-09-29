import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type AttemptId,
  type Clock,
  diagnostic,
  type Diagnostic,
  type ExecutionHandle,
  type ExecutionObserver,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  fromIso,
  type Logger,
  NOOP_OBSERVER,
  noopLogger,
  type NormalizedExecutionResult,
  type RuntimeInfo,
  type SecretProvider,
  systemClock,
  type TerminalStatus,
} from '@dvo/core';
import { envelopeResponseContract, extractJsonObject, parseEnvelope, Redactor } from '@dvo/evidence';
import { LineSplitter, parseHeadlessLine, type TurnEndReason } from './headless-protocol.ts';
import { costOf, type DshRuntimeLock, parseVersion, profileDigest } from './runtime-lock.ts';

export interface DshExecutorOptions {
  id?: string;
  lock: DshRuntimeLock;
  skills?: readonly string[];
  secrets?: SecretProvider;
  clock?: Clock;
  logger?: Logger;
  redactor?: Redactor;
  /** Max bytes of any non-final JSON line (DSH caps them at 32 KiB). */
  maxLineBytes?: number;
}

interface Probe {
  ok: boolean;
  runtime: RuntimeInfo;
  reason?: string;
}

/** Why the bridge itself stopped the child process. */
type KillReason = 'cancelled' | 'deadline' | 'output_budget';

/** Everything observed from one headless run; mapped to a result by `mapHeadlessRun`. */
export interface HeadlessRunObservation {
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killedBy?: KillReason;
  sessionSeen: boolean;
  turnEndReason?: string;
  finalText?: string;
  finalOversized: boolean;
  errorEvent?: { message: string; code?: string };
  inputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
  toolCalls: number;
  malformedLines: number;
  stderrTail: string;
}

/**
 * Local executor over DeepSeek Harness' one-shot headless runner (design §8). Each attempt
 * is one `dsh --profile <profile> --patch … --json -` child process:
 *  - the prompt goes over stdin (never argv, which is visible in `ps`);
 *  - the environment is rebuilt from an allowlist plus injected credentials;
 *  - the child gets its own process group, so cancel/deadline kill the whole tree;
 *  - `thinking` events and stderr reasoning are discarded, never stored;
 *  - output tokens are metered from `step_end` usage and the run is killed at the budget;
 *  - the final answer must contain an EvidenceEnvelope, or the attempt is `invalid_output`.
 * No DSH type crosses this package boundary: the core sees only Executor and its results.
 */
export class DshExecutor implements Executor {
  readonly id: string;
  readonly kind = 'dsh-local' as const;
  readonly #lock: DshRuntimeLock;
  readonly #skills: readonly string[];
  readonly #secrets: SecretProvider | undefined;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #maxLineBytes: number;
  #probe: Promise<Probe> | undefined;

  constructor(options: DshExecutorOptions) {
    this.id = options.id ?? 'dsh-local';
    // The child runs in `workdir`, so every path it is handed must be absolute.
    this.#lock = {
      ...options.lock,
      patchFiles: options.lock.patchFiles.map((file) => resolve(file)),
      workdir: resolve(options.lock.workdir),
    };
    this.#skills = options.skills ?? [];
    this.#secrets = options.secrets;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#redactor = options.redactor ?? new Redactor();
    this.#maxLineBytes = options.maxLineBytes ?? 64 * 1024;
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    const probe = await this.#probeOnce();
    return {
      kind: 'dsh-local',
      skills: this.#skills,
      maxEvidenceTier: 2,
      supportsCancel: true,
      supportsResume: false,
      supportsIdempotentResubmit: false,
      available: probe.ok,
      ...(probe.reason === undefined ? {} : { degradedReason: probe.reason }),
      runtime: probe.runtime,
    };
  }

  /** Re-probe the runtime (e.g. after an operator fixed the installation). */
  refresh(): void {
    this.#probe = undefined;
  }

  #probeOnce(): Promise<Probe> {
    this.#probe ??= this.#runProbe();
    return this.#probe;
  }

  async #runProbe(): Promise<Probe> {
    const lock = this.#lock;
    const base: RuntimeInfo = {
      name: 'deepseek-harness',
      version: lock.expectedVersion,
      profile: lock.profile,
      modelRoute: lock.modelRoute,
      ...(lock.commit === undefined ? {} : { commit: lock.commit }),
    };
    let digest: string;
    try {
      digest = await profileDigest(lock);
    } catch {
      return { ok: false, runtime: base, reason: 'profile patch file missing' };
    }
    const runtime: RuntimeInfo = { ...base, profileDigest: digest };
    const output = await new Promise<string | undefined>((resolve) => {
      execFile(
        lock.command[0]!,
        [...lock.command.slice(1), ...lock.versionArgs],
        { timeout: 15_000, env: this.#baseEnv() },
        (error, stdout, stderr) => {
          resolve(error === null ? `${stdout}\n${stderr}` : undefined);
        },
      );
    });
    if (output === undefined) return { ok: false, runtime, reason: 'dsh launcher not runnable' };
    const version = parseVersion(output);
    if (version === undefined) return { ok: false, runtime, reason: 'dsh version not detected' };
    const probed: RuntimeInfo = { ...runtime, version };
    if (lock.enforceVersion && version !== lock.expectedVersion) {
      return { ok: false, runtime: probed, reason: `version ${version} does not match lock ${lock.expectedVersion}` };
    }
    return { ok: true, runtime: probed };
  }

  #baseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.#lock.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    // Belt and braces: the locked patch also pins the sandbox; this keeps DSH's own default in step.
    env['DSH_PERMISSION_MODE'] = 'read-only';
    return env;
  }

  async #childEnv(): Promise<Record<string, string>> {
    const env = this.#baseEnv();
    for (const credential of this.#lock.credentialEnv ?? []) {
      if (this.#secrets === undefined) throw new Error('credentialEnv configured without a secret provider');
      env[credential.name] = (await this.#secrets.resolve(credential.ref)).reveal();
    }
    return env;
  }

  async start(request: ExecutionRequest, observer: ExecutionObserver = NOOP_OBSERVER): Promise<ExecutionHandle> {
    const attemptId = request.correlation.attemptId ?? ('att_local' as AttemptId);
    const startedAt = this.#clock.now();
    const probe = await this.#probeOnce();
    if (!probe.ok) {
      const result = this.#result(request, probe.runtime, 'failed', startedAt, [
        diagnostic('runtime_unavailable', `local runtime unavailable: ${probe.reason ?? 'unknown'}`),
      ]);
      return { attemptId, cancel: async () => undefined, result: async () => result };
    }

    let env: Record<string, string>;
    try {
      env = await this.#childEnv();
    } catch {
      const result = this.#result(request, probe.runtime, 'failed', startedAt, [
        diagnostic('credentials_unavailable', 'local runtime credentials could not be resolved'),
      ]);
      return { attemptId, cancel: async () => undefined, result: async () => result };
    }

    const lock = this.#lock;
    const argv = [
      ...lock.command.slice(1),
      '--profile',
      lock.profile,
      ...lock.patchFiles.flatMap((file) => ['--patch', file]),
      '--json',
      '-',
    ];
    const obs: HeadlessRunObservation = {
      exitCode: null,
      signal: null,
      sessionSeen: false,
      finalOversized: false,
      inputTokens: 0,
      outputTokens: 0,
      usageComplete: true,
      toolCalls: 0,
      malformedLines: 0,
      stderrTail: '',
    };

    let child: ChildProcess;
    try {
      child = spawn(lock.command[0]!, argv, { cwd: lock.workdir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      obs.spawnError = error as NodeJS.ErrnoException;
      const result = this.#map(request, probe.runtime, startedAt, obs);
      return { attemptId, cancel: async () => undefined, result: async () => result };
    }

    let killTimer: NodeJS.Timeout | undefined;
    const kill = (reason: KillReason): void => {
      if (obs.killedBy !== undefined || child.exitCode !== null) return;
      obs.killedBy = reason;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), lock.killGraceMs);
    };
    const deadline = this.#clock.setTimer(fromIso(request.budget.deadlineAt) - this.#clock.now(), () => kill('deadline'));

    const splitter = new LineSplitter(Math.max(this.#maxLineBytes, lock.maxFinalBytes));
    const onLine = (line: string): void => {
      const event = parseHeadlessLine(line);
      if (event === undefined) {
        obs.malformedLines += 1;
        return;
      }
      switch (event.type) {
        case 'session':
          obs.sessionSeen = true;
          return;
        case 'status':
          if (event.phase === 'step_end') {
            if (event.usage === undefined) obs.usageComplete = false;
            else {
              obs.inputTokens += event.usage.inputTokens;
              obs.outputTokens += event.usage.outputTokens + (event.usage.reasoningTokens ?? 0);
              if (obs.outputTokens > request.budget.maxOutputTokens || obs.inputTokens > request.budget.maxInputTokens)
                kill('output_budget');
            }
          }
          if (event.phase === 'turn_end' && event.reason !== undefined) obs.turnEndReason = event.reason;
          if (event.phase === 'turn_end' && event.error !== undefined) obs.errorEvent = event.error;
          return;
        case 'tool_call':
          obs.toolCalls += 1;
          return;
        case 'final':
          if (Buffer.byteLength(event.text) > lock.maxFinalBytes) obs.finalOversized = true;
          else obs.finalText = event.text;
          return;
        case 'error':
          obs.errorEvent = { message: event.message, ...(event.code === undefined ? {} : { code: event.code }) };
          return;
        case 'thinking': // raw reasoning: intentionally dropped (invariant 6)
        case 'text':
        case 'tool_result':
          return;
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk, onLine, () => (obs.finalOversized = true)));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep only launcher diagnostics; `dsh: reasoning:` sections are model reasoning and are discarded.
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('dsh: ') || line.startsWith('dsh: reasoning')) continue;
        obs.stderrTail = `${obs.stderrTail}\n${line}`.slice(-2048);
      }
    });

    const result = new Promise<NormalizedExecutionResult>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        if (killTimer !== undefined) clearTimeout(killTimer);
        splitter.flush(onLine);
        resolve(this.#map(request, probe.runtime, startedAt, obs));
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        obs.spawnError = error;
        finish();
      });
      child.on('close', (code, signal) => {
        obs.exitCode = code;
        obs.signal = signal;
        finish();
      });
    });

    child.stdin?.on('error', () => undefined); // EPIPE if the child exits before reading
    child.stdin?.end(`${request.prompt}\n\n${envelopeResponseContract(request.requestedTier)}\n`);
    observer.onProgress({ kind: 'started' });
    this.#logger.debug({ attemptId, runtime: probe.runtime.version, profileDigest: probe.runtime.profileDigest }, 'dsh attempt started');

    return {
      attemptId,
      cancel: async () => kill('cancelled'),
      result: () => result,
    };
  }

  #map(request: ExecutionRequest, runtime: RuntimeInfo, startedAt: number, obs: HeadlessRunObservation): NormalizedExecutionResult {
    const mapped = mapHeadlessRun(obs);
    const diagnostics = mapped.diagnostics.map((d) => ({ ...d, safeMessage: this.#redactor.redactText(d.safeMessage).value }));
    const base = this.#result(request, runtime, mapped.status, startedAt, diagnostics);
    const usage = {
      ...base.usage,
      inputTokens: obs.inputTokens,
      outputTokens: obs.outputTokens,
      costUsd: costOf(this.#lock, obs.inputTokens, obs.outputTokens),
    };
    if (mapped.status !== 'completed' || obs.finalText === undefined) return { ...base, usage };
    const raw = extractJsonObject(obs.finalText);
    const parsed = raw === undefined ? undefined : parseEnvelope(raw, request.correlation);
    if (parsed === undefined || !parsed.ok) {
      const issue = parsed === undefined ? 'no JSON object in the final answer' : parsed.issues.slice(0, 3).join('; ');
      return {
        ...base,
        usage,
        terminalStatus: 'invalid_output',
        diagnostics: [
          ...diagnostics,
          diagnostic('structured_output_invalid', `final answer is not a valid EvidenceEnvelope: ${issue}`, true),
        ],
      };
    }
    return { ...base, usage, output: parsed.envelope, ...(obs.killedBy === 'cancelled' ? { afterCancel: true } : {}) };
  }

  #result(
    request: ExecutionRequest,
    runtime: RuntimeInfo,
    status: TerminalStatus,
    startedAt: number,
    diagnostics: Diagnostic[],
  ): NormalizedExecutionResult {
    return {
      correlation: request.correlation,
      executorId: this.id,
      terminalStatus: status,
      usage: { elapsedMs: this.#clock.now() - startedAt },
      diagnostics,
      runtime,
    };
  }
}

/**
 * Pure mapping from what a headless run did to a terminal status (contract-tested):
 * exit 0 + `turn_end completed` + `final` → completed; refusal → refused; bridge kills →
 * cancelled / timed_out / failed(output budget); model errors retryable; crashes retryable;
 * a missing launcher is not.
 */
export function mapHeadlessRun(obs: HeadlessRunObservation): { status: TerminalStatus; diagnostics: Diagnostic[] } {
  if (obs.spawnError !== undefined) {
    const missing = obs.spawnError.code === 'ENOENT' || obs.spawnError.code === 'EACCES';
    return {
      status: 'failed',
      diagnostics: [diagnostic(missing ? 'runtime_unavailable' : 'spawn_failed', 'could not start the local runtime', !missing)],
    };
  }
  if (obs.killedBy === 'deadline')
    return { status: 'timed_out', diagnostics: [diagnostic('deadline_exceeded', 'local attempt exceeded its deadline', true)] };
  if (obs.killedBy === 'output_budget')
    return { status: 'failed', diagnostics: [diagnostic('token_budget_exceeded', 'local attempt exceeded its token budget')] };
  const reason = obs.turnEndReason as TurnEndReason | undefined;
  if (obs.killedBy === 'cancelled') {
    // A run that had already finished its turn when the kill landed is a late result, not a cancellation.
    if (reason === 'completed' && obs.finalText !== undefined)
      return { status: 'completed', diagnostics: [diagnostic('completed_after_cancel', 'result arrived after cancel')] };
    return { status: 'cancelled', diagnostics: [diagnostic('cancelled', 'local attempt cancelled')] };
  }
  if (obs.finalOversized)
    return { status: 'invalid_output', diagnostics: [diagnostic('output_too_large', 'final answer exceeds the size limit')] };
  if (obs.exitCode === 0 && reason === 'completed' && obs.finalText !== undefined) return { status: 'completed', diagnostics: [] };
  switch (reason) {
    case 'refusal':
      return { status: 'refused', diagnostics: [diagnostic('refusal', 'the local agent declined the task')] };
    case 'max-tokens':
      return { status: 'failed', diagnostics: [diagnostic('max_tokens', 'the local agent hit its token ceiling')] };
    case 'error': {
      // Configuration faults (missing credentials, unknown model route) will not fix themselves on retry.
      const code = obs.errorEvent?.code;
      const permanent = code !== undefined && /CREDENTIAL|AUTH|NOT_FOUND|INVALID|CONFIG/i.test(code);
      return {
        status: 'failed',
        diagnostics: [
          diagnostic(
            code === undefined ? 'model_error' : `dsh_${code.toLowerCase()}`,
            obs.errorEvent === undefined
              ? 'model or transport error in the local runtime'
              : `local runtime error: ${obs.errorEvent.message.slice(0, 300)}`,
            !permanent,
          ),
        ],
      };
    }
    case 'aborted':
      return { status: 'failed', diagnostics: [diagnostic('aborted', 'the local run was aborted', true)] };
    default:
      break;
  }
  if (obs.errorEvent !== undefined) {
    return {
      status: 'failed',
      diagnostics: [
        diagnostic(`dsh_${obs.errorEvent.code ?? 'error'}`, `local runtime error: ${obs.errorEvent.message.slice(0, 300)}`, true),
      ],
    };
  }
  const detail = obs.signal !== null ? `signal ${obs.signal}` : `exit ${String(obs.exitCode)}`;
  const lastDiagnostic = obs.stderrTail
    .trim()
    .split('\n')
    .at(-1)
    ?.replace(/^dsh: /, '')
    .slice(0, 300);
  const suffix = lastDiagnostic === undefined || lastDiagnostic === '' ? '' : `: ${lastDiagnostic}`;
  return {
    status: 'failed',
    diagnostics: [diagnostic('subagent_crashed', `local runtime ended without a result (${detail})${suffix}`, true)],
  };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
