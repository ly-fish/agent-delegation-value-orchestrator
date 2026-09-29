import { readFile } from 'node:fs/promises';
import { digestOf, sha256Hex } from '@dvo/core';

/**
 * Everything that pins the local DSH runtime (design §8.3, §18.1). Loaded from
 * `configs/runtime-lock.yaml`; any change is a deliberate, reviewed version bump.
 */
export interface DshRuntimeLock {
  /** Launcher argv prefix, e.g. ["dsh"] or ["npx", "--no-install", "@deepseek-ai/dsh"]. */
  command: readonly string[];
  /** Exact DSH release the bridge was contract-tested against. */
  expectedVersion: string;
  commit?: string;
  /** Named DSH profile; the bridge only drives the one-shot `headless` runner. */
  profile: string;
  /** Ordered `--patch` overlays (tool allowlist, sandbox, approval, subagent depth). */
  patchFiles: readonly string[];
  /** Model route recorded in every trace (e.g. "deepseek/deepseek-v4"). */
  modelRoute: string;
  /** Tools the patch permits; recorded for audit and folded into the profile digest. */
  toolAllowlist: readonly string[];
  /** Price table used to turn reported tokens into cost. */
  pricing: { inputPerMTokUsd: number; outputPerMTokUsd: number };
  /** Environment variables forwarded to the child (everything else is dropped). */
  envAllowlist: readonly string[];
  /** Credentials injected into the child environment from the secret provider. */
  credentialEnv?: ReadonlyArray<{ name: string; ref: string }>;
  /** Argv appended to `command` to print the version. */
  versionArgs: readonly string[];
  /** Refuse to run when the probed version differs from `expectedVersion`. */
  enforceVersion: boolean;
  /** Working directory the agent runs in (its sandbox workspace root). */
  workdir: string;
  /** Hard cap on the `final` event (the only unbounded line in DSH's JSON stream). */
  maxFinalBytes: number;
  /** SIGTERM → SIGKILL grace when cancelling. */
  killGraceMs: number;
}

export const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_OPTIONS', 'DSH_HOME'] as const;

/**
 * Digest identifying the effective local profile: profile name, the exact bytes of every
 * patch overlay, model route and tool allowlist. Written into every trace (design §8.3).
 */
export async function profileDigest(lock: DshRuntimeLock): Promise<string> {
  const patches = await Promise.all(lock.patchFiles.map(async (file) => ({ file, sha256: sha256Hex(await readFile(file)) })));
  return digestOf({
    profile: lock.profile,
    patches,
    modelRoute: lock.modelRoute,
    toolAllowlist: [...lock.toolAllowlist].sort(),
    expectedVersion: lock.expectedVersion,
  });
}

export function costOf(lock: DshRuntimeLock, inputTokens: number, outputTokens: number): number {
  const cost = (inputTokens * lock.pricing.inputPerMTokUsd + outputTokens * lock.pricing.outputPerMTokUsd) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

/** Extracts the first semantic version from launcher output ("dsh 0.2.0-rc.1" → "0.2.0-rc.1"). */
export function parseVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}
