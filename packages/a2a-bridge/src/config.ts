import type { PeerId, TrustTier } from '@dvo/core';

/** One allowlisted A2A peer (design appendix B, §9.4). */
export interface PeerConfig {
  id: PeerId;
  /** Base URL of the peer; its Agent Card is served from this origin's well-known path. */
  endpoint: string;
  /** Explicit allowlist switch: a peer with `allowed: false` is never contacted. */
  allowed: boolean;
  trustTier: TrustTier;
  maxConcurrency: number;
  /** Deadline for one attempt on this peer (the task deadline may be tighter). */
  timeoutMs: number;
  /** Per-request HTTP timeout. */
  requestTimeoutMs: number;
  maxArtifactBytes: number;
  allowedSkills: readonly string[];
  /** `secret://…` reference resolved by the secret provider at call time. */
  credentialsRef?: string;
  authScheme: 'bearer' | 'api-key' | 'none';
  apiKeyHeader: string;
  /** Extensions this client will activate when the peer's card declares them. */
  extensionUris: readonly string[];
  /** Only for peers under our control that de-duplicate SendMessage by messageId. */
  dedupSupported: boolean;
  /** Sandbox approved for restricted data (still requires per-task approval). */
  allowRestricted: boolean;
  /** Estimated cost per call (USD) until observed costs exist. */
  costPerCallUsd: number;
  /** Hosts artifacts may be fetched from; defaults to the endpoint host. */
  artifactHosts: readonly string[];
  artifactMimeTypes: readonly string[];
  /** Development/tests only: allow plain-http loopback endpoints. */
  allowInsecureLoopback: boolean;
  poll: { initialDelayMs: number; maxDelayMs: number; multiplier: number };
  /** Upper bound on how long a fetched Agent Card is trusted without revalidation. */
  cardTtlMs: number;
  /** Accepted A2A protocol versions (Major.Minor), locked by configuration (design §9.3). */
  protocolVersions: readonly string[];
}

export function peerConfig(partial: Partial<PeerConfig> & Pick<PeerConfig, 'id' | 'endpoint'>): PeerConfig {
  const host = safeHost(partial.endpoint);
  return {
    allowed: true,
    trustTier: 'public',
    maxConcurrency: 2,
    timeoutMs: 60_000,
    requestTimeoutMs: 15_000,
    maxArtifactBytes: 5 * 1024 * 1024,
    allowedSkills: [],
    authScheme: 'none',
    apiKeyHeader: 'x-api-key',
    extensionUris: [],
    dedupSupported: false,
    allowRestricted: false,
    costPerCallUsd: 0.01,
    artifactHosts: host === undefined ? [] : [host],
    artifactMimeTypes: ['application/json', 'text/plain', 'text/markdown', 'text/csv'],
    allowInsecureLoopback: false,
    poll: { initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 1.6 },
    cardTtlMs: 5 * 60_000,
    protocolVersions: ['1.0'],
    ...partial,
  };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
