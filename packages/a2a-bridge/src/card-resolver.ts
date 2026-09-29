import { type Clock, digestOf, HarnessError, type Logger, noopLogger, type PeerId, systemClock } from '@dvo/core';
import { hostAllowed, isLoopbackHost } from '@dvo/evidence';
import type { PeerConfig } from './config.ts';
import { readCapped } from './transport.ts';
import { AGENT_CARD_PATH, type AgentCard, AgentCardSchema, EVIDENCE_EXTENSION_URI, JSONRPC_BINDING } from './wire.ts';

/** What this system believes about a peer: candidate information, never evidence of trust (invariant 4). */
export interface PeerProfile {
  peerId: PeerId;
  card: AgentCard;
  cardDigest: string;
  rpcUrl: string;
  protocolVersion: string;
  /** Extensions both declared by the card and enabled in our configuration. */
  activeExtensions: string[];
  supportsEvidenceExtension: boolean;
  declaredSkills: string[];
  streaming: boolean;
  fetchedAt: number;
  expiresAt: number;
  etag?: string;
}

const MAX_CARD_BYTES = 256 * 1024;
const MIN_CARD_TTL_MS = 30_000;

/**
 * Agent Card discovery with validation and caching (design §9.1):
 * allowlist + HTTPS → size-capped fetch → schema → a JSON-RPC interface in the locked
 * version range whose host is the peer's own → cache honouring `Cache-Control: max-age`
 * (bounded by `cardTtlMs`) and revalidating with `If-None-Match`.
 */
export class AgentCardResolver {
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #cache = new Map<PeerId, PeerProfile>();
  readonly #inflight = new Map<PeerId, Promise<PeerProfile>>();

  constructor(options: { fetch?: typeof fetch; clock?: Clock; logger?: Logger } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
  }

  cached(peerId: PeerId): PeerProfile | undefined {
    return this.#cache.get(peerId);
  }

  invalidate(peerId: PeerId): void {
    this.#cache.delete(peerId);
  }

  async resolve(peer: PeerConfig, signal?: AbortSignal): Promise<PeerProfile> {
    if (!peer.allowed) throw new HarnessError('peer_not_allowed', `peer ${peer.id} is not allowlisted`);
    const cached = this.#cache.get(peer.id);
    if (cached !== undefined && cached.expiresAt > this.#clock.now()) return cached;
    const pending = this.#inflight.get(peer.id);
    if (pending !== undefined) return pending;
    const work = this.#fetchCard(peer, cached, signal).finally(() => this.#inflight.delete(peer.id));
    this.#inflight.set(peer.id, work);
    return work;
  }

  async #fetchCard(peer: PeerConfig, previous: PeerProfile | undefined, signal?: AbortSignal): Promise<PeerProfile> {
    const base = parseEndpoint(peer);
    const cardUrl = new URL(AGENT_CARD_PATH, base.origin);
    let response: Response;
    try {
      response = await this.#fetch(cardUrl, {
        headers: {
          accept: 'application/json',
          'a2a-version': '1.0',
          ...(previous?.etag === undefined ? {} : { 'if-none-match': previous.etag }),
        },
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(peer.requestTimeoutMs),
      });
    } catch (error) {
      throw new HarnessError('protocol_error', `agent card of ${peer.id} unreachable`, { retryable: true, cause: error });
    }
    const now = this.#clock.now();
    const ttl = ttlFrom(response.headers.get('cache-control'), peer.cardTtlMs);
    if (response.status === 304 && previous !== undefined) {
      await response.body?.cancel();
      const refreshed = { ...previous, fetchedAt: now, expiresAt: now + ttl };
      this.#cache.set(peer.id, refreshed);
      return refreshed;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HarnessError('protocol_error', `agent card of ${peer.id} returned HTTP ${response.status}`, {
        retryable: response.status >= 500,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readCapped(response, MAX_CARD_BYTES));
    } catch {
      throw new HarnessError('protocol_error', `agent card of ${peer.id} is not valid JSON or too large`);
    }
    const card = AgentCardSchema.safeParse(parsed);
    if (!card.success) {
      throw new HarnessError('validation_failed', `agent card of ${peer.id} does not match the A2A v1.0 schema`, {
        details: { issues: card.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
    }
    const profile = buildProfile(peer, card.data, base, now, ttl, response.headers.get('etag') ?? undefined);
    if (previous !== undefined && previous.cardDigest !== profile.cardDigest) {
      this.#logger.info({ peerId: peer.id, from: previous.cardDigest, to: profile.cardDigest }, 'agent card changed');
    }
    this.#cache.set(peer.id, profile);
    return profile;
  }
}

function parseEndpoint(peer: PeerConfig): URL {
  let url: URL;
  try {
    url = new URL(peer.endpoint);
  } catch {
    throw new HarnessError('validation_failed', `peer ${peer.id} endpoint is not a URL`);
  }
  const insecureOk = url.protocol === 'http:' && peer.allowInsecureLoopback && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !insecureOk) throw new HarnessError('peer_not_allowed', `peer ${peer.id} endpoint must use HTTPS`);
  if (url.username !== '' || url.password !== '')
    throw new HarnessError('validation_failed', `peer ${peer.id} endpoint must not embed credentials`);
  return url;
}

export function buildProfile(peer: PeerConfig, card: AgentCard, base: URL, now: number, ttlMs: number, etag?: string): PeerProfile {
  const iface = card.supportedInterfaces.find(
    (i) => i.protocolBinding.toUpperCase() === JSONRPC_BINDING && peer.protocolVersions.includes(majorMinor(i.protocolVersion)),
  );
  if (iface === undefined) {
    throw new HarnessError(
      'validation_failed',
      `peer ${peer.id} offers no JSON-RPC interface in versions ${peer.protocolVersions.join(', ')}`,
    );
  }
  let rpc: URL;
  try {
    rpc = new URL(iface.url, base);
  } catch {
    throw new HarnessError('validation_failed', `peer ${peer.id} JSON-RPC URL is invalid`);
  }
  // A card must not redirect us to an endpoint outside the peer's allowlisted hosts (SSRF / pivot).
  const allowedHosts = [base.hostname, ...peer.artifactHosts];
  const insecureOk = rpc.protocol === 'http:' && peer.allowInsecureLoopback && isLoopbackHost(rpc.hostname);
  if ((rpc.protocol !== 'https:' && !insecureOk) || !hostAllowed(rpc.hostname, allowedHosts)) {
    throw new HarnessError('peer_not_allowed', `peer ${peer.id} JSON-RPC URL is outside its allowlisted hosts`);
  }
  const declared = card.capabilities.extensions ?? [];
  const unsupportedRequired = declared.filter((e) => e.required === true && !peer.extensionUris.includes(e.uri));
  if (unsupportedRequired.length > 0) {
    throw new HarnessError('validation_failed', `peer ${peer.id} requires unsupported extensions`, {
      details: { extensions: unsupportedRequired.map((e) => e.uri) },
    });
  }
  const activeExtensions = declared.map((e) => e.uri).filter((uri) => peer.extensionUris.includes(uri));
  return {
    peerId: peer.id,
    card,
    cardDigest: digestOf(card),
    rpcUrl: rpc.toString(),
    protocolVersion: iface.protocolVersion,
    activeExtensions,
    supportsEvidenceExtension: activeExtensions.includes(EVIDENCE_EXTENSION_URI),
    declaredSkills: card.skills.map((s) => s.id),
    streaming: card.capabilities.streaming === true,
    fetchedAt: now,
    expiresAt: now + ttlMs,
    ...(etag === undefined ? {} : { etag }),
  };
}

function majorMinor(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${minor}`;
}

function ttlFrom(cacheControl: string | null, maxTtlMs: number): number {
  const match = /max-age=(\d+)/i.exec(cacheControl ?? '');
  const declared = match === null ? maxTtlMs : Number(match[1]) * 1000;
  if (/no-store|no-cache/i.test(cacheControl ?? '')) return MIN_CARD_TTL_MS;
  return Math.max(MIN_CARD_TTL_MS, Math.min(maxTtlMs, declared));
}
