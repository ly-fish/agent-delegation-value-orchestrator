import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_CLAIM_ID, type VerificationInput, type VerificationOutcome, type Verifier } from '@dvo/core';

export interface CommandRecipe {
  /** argv; `{input}` is replaced by the path of the file holding the candidate answer. */
  command: readonly string[];
  timeoutMs: number;
  /** Environment variables passed through by name (everything else is dropped). */
  envAllowlist?: readonly string[];
  /** Maximum bytes of stdout/stderr retained for the (redacted) detail message. */
  maxOutputBytes?: number;
}

/**
 * Runs a locally configured check (unit tests, a checker script) against a candidate
 * answer in an isolated temporary directory (design §12.2):
 *  - the recipe comes from configuration, never from task input or peer evidence;
 *  - `shell: false`, a fresh working directory, and an environment reduced to PATH plus an
 *    explicit allowlist, so no credentials are inherited;
 *  - hard timeout that kills the whole process group.
 * Exit code 0 verifies the claim; any other exit code refutes it.
 */
export class CommandVerifier implements Verifier {
  readonly id: string;
  readonly deterministic = true;
  readonly #recipe: CommandRecipe;

  constructor(id: string, recipe: CommandRecipe) {
    if (recipe.command.length === 0) throw new RangeError('command verifier needs a command');
    this.id = id;
    this.#recipe = recipe;
  }

  async available(): Promise<boolean> {
    const bin = this.#recipe.command[0]!;
    if (!bin.includes('/')) return true;
    try {
      await access(bin);
      return true;
    } catch {
      return false;
    }
  }

  async verify(input: VerificationInput, signal: AbortSignal): Promise<VerificationOutcome> {
    const claimId = typeof input.spec.params?.['claimId'] === 'string' ? input.spec.params['claimId'] : ANSWER_CLAIM_ID;
    const claim = input.candidate.claims.find((c) => c.id === claimId);
    if (claim === undefined) return { outcome: 'refuted', claimVerdicts: [], detail: `no claim with id "${claimId}"` };

    const dir = await mkdtemp(join(tmpdir(), 'dvo-verify-'));
    try {
      const inputPath = join(dir, 'candidate.txt');
      await writeFile(inputPath, claim.statement, { mode: 0o600 });
      const argv = this.#recipe.command.map((part) => part.replaceAll('{input}', inputPath));
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' };
      for (const name of this.#recipe.envAllowlist ?? []) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const { code, output } = await run(argv, dir, env, this.#recipe.timeoutMs, this.#recipe.maxOutputBytes ?? 4096, signal);
      const ok = code === 0;
      return {
        outcome: ok ? 'verified' : 'refuted',
        claimVerdicts: [{ claimId, verdict: ok ? 'verified' : 'refuted' }],
        detail: `exit ${code === null ? 'timeout' : code}${output === '' ? '' : `: ${output}`}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function run(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  maxOutput: number,
  signal: AbortSignal,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length < maxOutput) output += chunk.toString('utf8').slice(0, maxOutput - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    const onAbort = (): void => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, output: output.trim() });
    });
  });
}
