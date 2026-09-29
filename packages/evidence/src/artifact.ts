import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { EvidenceItem } from '@dvo/core';

/** Per-peer artifact admission policy (design §6.3.2, appendix B `maxArtifactBytes`). */
export interface ArtifactPolicy {
  /** Exact hostnames or `*.suffix` wildcards. Empty means no remote artifact is admitted. */
  allowedHosts: readonly string[];
  /** MIME types; `type/*` wildcards allowed. */
  allowedMimeTypes: readonly string[];
  maxBytes: number;
  /** Require a declared SHA-256 before any download (always true for tier-2 evidence). */
  requireSha256: boolean;
  /** Development only: permit plain-http loopback URLs (mock peers, tests). */
  allowInsecureLoopback?: boolean;
}

export type ArtifactRejectReason =
  | 'invalid_url'
  | 'insecure_scheme'
  | 'credentials_in_url'
  | 'host_not_allowed'
  | 'private_address'
  | 'mime_missing'
  | 'mime_not_allowed'
  | 'size_missing'
  | 'too_large'
  | 'sha256_missing'
  | 'sha256_mismatch'
  | 'content_type_mismatch'
  | 'download_failed'
  | 'tier_not_supported';

export type ArtifactCheck = { ok: true; url: URL } | { ok: false; reason: ArtifactRejectReason };

export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = {
  allowedHosts: [],
  allowedMimeTypes: ['application/json', 'text/plain', 'text/markdown', 'text/csv'],
  maxBytes: 5 * 1024 * 1024,
  requireSha256: true,
};

/** Checks run *before* any network access: URL shape, host allowlist, MIME, declared size and digest. */
export function checkArtifactRef(item: EvidenceItem, policy: ArtifactPolicy): ArtifactCheck {
  if (item.uri === undefined) return { ok: false, reason: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(item.uri);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && policy.allowInsecureLoopback === true)) {
    return { ok: false, reason: 'insecure_scheme' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials_in_url' };
  if (!hostAllowed(url.hostname, policy.allowedHosts)) return { ok: false, reason: 'host_not_allowed' };
  if (isPrivateAddress(url.hostname) && !(loopback && policy.allowInsecureLoopback === true)) {
    return { ok: false, reason: 'private_address' };
  }
  if (item.mimeType === undefined) return { ok: false, reason: 'mime_missing' };
  if (!mimeAllowed(item.mimeType, policy.allowedMimeTypes)) return { ok: false, reason: 'mime_not_allowed' };
  if (item.bytes === undefined) return { ok: false, reason: 'size_missing' };
  if (item.bytes > policy.maxBytes) return { ok: false, reason: 'too_large' };
  if (policy.requireSha256 && item.sha256 === undefined) return { ok: false, reason: 'sha256_missing' };
  return { ok: true, url };
}

export interface FetchedArtifact {
  bytes: Uint8Array;
  sha256: string;
  mimeType: string;
}

export type FetchArtifactResult = { ok: true; artifact: FetchedArtifact } | { ok: false; reason: ArtifactRejectReason };

/**
 * Streams an admitted artifact with a hard byte cap, verifies content type and SHA-256.
 * Redirects are refused so an allowlisted host cannot bounce the download elsewhere.
 * The bytes are only ever handed to a quarantine store; nothing here executes them.
 */
export async function fetchArtifact(
  item: EvidenceItem,
  policy: ArtifactPolicy,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<FetchArtifactResult> {
  const check = checkArtifactRef(item, policy);
  if (!check.ok) return check;
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(check.url, {
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { ok: false, reason: 'download_failed' };
  }
  if (!response.ok || response.body === null) return { ok: false, reason: 'download_failed' };
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== '' && contentType !== item.mimeType!.toLowerCase()) {
    await response.body.cancel();
    return { ok: false, reason: 'content_type_mismatch' };
  }
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > policy.maxBytes) {
    await response.body.cancel();
    return { ok: false, reason: 'too_large' };
  }
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      return { ok: false, reason: 'download_failed' };
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > policy.maxBytes) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    hash.update(chunk.value);
    chunks.push(chunk.value);
  }
  const sha256 = hash.digest('hex');
  if (item.sha256 !== undefined && sha256 !== item.sha256) return { ok: false, reason: 'sha256_mismatch' };
  return { ok: true, artifact: { bytes: Buffer.concat(chunks), sha256, mimeType: item.mimeType! } };
}

/**
 * Content-addressed quarantine directory for inbound artifacts. Files are written with
 * mode 0600 (never executable) under their digest; verifiers read them from here.
 */
export class QuarantineStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(bytes: Uint8Array): Promise<{ sha256: string; path: string }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = join(this.#root, sha256.slice(0, 2));
    const path = join(dir, sha256);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
    return { sha256, path };
  }

  async get(sha256: string): Promise<Uint8Array | undefined> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return undefined;
    try {
      return await readFile(join(this.#root, sha256.slice(0, 2), sha256));
    } catch {
      return undefined;
    }
  }
}

export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}

export function mimeAllowed(mimeType: string, allowed: readonly string[]): boolean {
  const mime = mimeType.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : mime === p;
  });
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** IP literals in loopback, private, link-local or unique-local ranges (SSRF guard). */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host.startsWith('::ffff:')
    );
  }
  return false;
}
