import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Clock,
  type HarnessStore,
  type Logger,
  PeerId,
  RandomIdGenerator,
  type SecretProvider,
  systemClock,
  toIso,
  type Verifier,
} from '@dvo/core';
import { A2aPeerExecutor, AgentCardResolver, peerConfig, type PeerConfig } from '@dvo/a2a-bridge';
import { DshExecutor, type DshRuntimeLock } from '@dvo/dsh-bridge';
import { type ArtifactPolicy, QuarantineStore, Redactor } from '@dvo/evidence';
import {
  DEFAULT_INGRESS_LIMITS,
  type ExecutorCatalog,
  type IngressLimits,
  type LocalDescriptor,
  OrchestrationEngine,
  type PeerDescriptor,
  ReliabilityTracker,
} from '@dvo/orchestrator';
import { DvoRulePolicy, policyConfig, ShrinkageCalibrator } from '@dvo/policy';
import { AttemptScheduler, circuitGaugeValue, CircuitRegistry } from '@dvo/scheduler';
import { MetricsRegistry, SqliteStore } from '@dvo/trace';
import { ArtifactDigestVerifier, CommandVerifier, ExactAnswerVerifier, RegexVerifier, VerifierRegistry } from '@dvo/verifier';
import type { LoadedConfig } from './config/load.ts';
import type { PeerFileEntry, VerifierEntry } from './config/schema.ts';
import { EnvFileSecretProvider } from './secrets.ts';

export interface App {
  config: LoadedConfig;
  engine: OrchestrationEngine;
  store: HarnessStore;
  metrics: MetricsRegistry;
  catalog: ExecutorCatalog;
  circuits: CircuitRegistry;
  secrets: SecretProvider;
  peers: Map<string, PeerConfig>;
  logger: Logger;
  close(options?: { cancelActive: boolean }): Promise<void>;
}

export interface BuildOverrides {
  clock?: Clock;
  store?: HarnessStore;
  secrets?: SecretProvider;
  fetch?: typeof fetch;
}

/**
 * Composition root (design §4.2): the only place where concrete adapters meet the ports.
 * Everything above it (engine, policy, bridges) is constructed from configuration here and
 * never reads configuration or environment on its own.
 */
export async function buildApp(config: LoadedConfig, logger: Logger, overrides: BuildOverrides = {}): Promise<App> {
  const clock = overrides.clock ?? systemClock;
  const redactor = new Redactor();
  const metrics = new MetricsRegistry();
  const secrets =
    overrides.secrets ??
    new EnvFileSecretProvider({
      envPrefix: config.service.secrets.envPrefix,
      ...(config.service.secrets.dir === undefined ? {} : { dir: config.service.secrets.dir }),
    });
  const store = overrides.store ?? new SqliteStore(config.service.storage.sqlitePath, { sanitize: (v) => redactor.redact(v).value, clock });
  const quarantine = new QuarantineStore(config.service.storage.quarantineDir);
  const ids = new RandomIdGenerator(clock);

  const circuitOptions = config.policy.circuit;
  const circuits = new CircuitRegistry(
    clock,
    () => circuitOptions,
    (id, from, to, reason) => {
      metrics.set('dvo_circuit_state', circuitGaugeValue(to), { peer: id });
      logger.warn({ peerId: id, from, to, reason }, 'circuit state changed');
      const peer = config.peers.find((p) => p.id === id);
      if (peer !== undefined) {
        void store
          .upsertPeer({ peerId: PeerId(id), trustTier: peer.trustTier, circuit: to, circuitChangedAt: toIso(clock.now()) })
          .catch(() => undefined);
      }
    },
  );

  const peerConfigs = new Map<string, PeerConfig>();
  for (const entry of config.peers) peerConfigs.set(entry.id, toPeerConfig(entry, config.lock.a2a.protocolVersions));
  const resolver = new AgentCardResolver({ clock, logger, ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }) });
  const peers: PeerDescriptor[] = [];
  for (const peer of peerConfigs.values()) {
    if (!peer.allowed) continue; // not allowlisted: never constructed, never contacted
    const executor = new A2aPeerExecutor(peer, {
      resolver,
      ledger: store,
      secrets,
      clock,
      logger,
      metrics,
      redactor,
      quarantine,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    peers.push({
      peerId: peer.id,
      executor,
      trustTier: peer.trustTier,
      allowRestricted: peer.allowRestricted,
      costPerCallUsd: peer.costPerCallUsd,
      timeoutMs: peer.timeoutMs,
      maxConcurrency: peer.maxConcurrency,
    });
    await store.upsertPeer({ peerId: peer.id, trustTier: peer.trustTier, circuit: 'closed' });
  }

  let local: LocalDescriptor | undefined;
  if (config.service.local.enabled) {
    const lock = stripUndefined(config.lock.dsh) as DshRuntimeLock;
    mkdirSync(lock.workdir, { recursive: true, mode: 0o700 });
    local = {
      executor: new DshExecutor({ lock, skills: config.service.local.skills, secrets, clock, logger, redactor }),
      costEstimateUsd: config.service.local.costEstimateUsd,
      timeoutMs: config.service.local.timeoutMs,
      maxConcurrency: config.service.local.maxConcurrency,
    };
  }

  const verifiers = new VerifierRegistry(
    config.service.verifiers.map((v) => buildVerifier(v, quarantine)),
    () => clock.now(),
  );
  const catalog: ExecutorCatalog = { ...(local === undefined ? {} : { local }), peers, verifiers };

  const limits = config.service.ingress === undefined ? DEFAULT_INGRESS_LIMITS : (config.service.ingress satisfies IngressLimits);
  const concurrency = new Map<string, number>([
    ...(local === undefined ? [] : [[local.executor.id, local.maxConcurrency] as [string, number]]),
    ...peers.map((p) => [p.executor.id, p.maxConcurrency] as [string, number]),
  ]);
  const scheduler = new AttemptScheduler({
    clock,
    globalConcurrency: config.service.scheduler.globalConcurrency,
    executorConcurrency: (id) => concurrency.get(id) ?? 2,
    cancelGraceMs: config.service.scheduler.cancelGraceMs,
    metrics,
    logger,
  });

  const r = config.policy.reliability;
  const reliability = new ReliabilityTracker(store, {
    priors: { local: { alpha: r.localPrior[0], beta: r.localPrior[1] }, peer: { alpha: r.peerPrior[0], beta: r.peerPrior[1] } },
    calibrator: new ShrinkageCalibrator(r.calibratorWeight, r.calibratorHalfLife),
  });
  await reliability.refresh();

  const { trustPenalty, exploration, ...policyRest } = config.policy.policy;
  const policy = new DvoRulePolicy(
    policyConfig({
      ...stripUndefined(policyRest),
      ...(trustPenalty === undefined ? {} : { trustPenalty: { ...policyConfig().trustPenalty, ...stripUndefined(trustPenalty) } }),
      ...(exploration === undefined ? {} : { exploration: { ...policyConfig().exploration, ...stripUndefined(exploration) } }),
    }),
  );

  const engine = new OrchestrationEngine({
    store,
    policy,
    scheduler,
    catalog,
    circuits,
    reliability,
    redactor,
    clock,
    ids,
    logger,
    metrics,
    ingressLimits: limits,
    config: {
      ...stripUndefined(config.policy.engine),
      artifactPolicy: (peer) => artifactPolicyOf(peerConfigs.get(peer.peerId)!),
    },
  });

  return {
    config,
    engine,
    store,
    metrics,
    catalog,
    circuits,
    secrets,
    peers: peerConfigs,
    logger,
    close: async (options = { cancelActive: false }) => {
      await engine.shutdown(options);
      await store.close();
    },
  };
}

export function toPeerConfig(entry: PeerFileEntry, protocolVersions: readonly string[]): PeerConfig {
  return peerConfig({
    ...stripUndefined(entry),
    id: PeerId(entry.id),
    protocolVersions,
    ...(entry.credentialsRef === undefined ? {} : { credentialsRef: entry.credentialsRef }),
  });
}

function artifactPolicyOf(peer: PeerConfig): ArtifactPolicy {
  return {
    allowedHosts: peer.artifactHosts,
    allowedMimeTypes: peer.artifactMimeTypes,
    maxBytes: peer.maxArtifactBytes,
    requireSha256: true,
    allowInsecureLoopback: peer.allowInsecureLoopback,
  };
}

function buildVerifier(entry: VerifierEntry, quarantine: QuarantineStore): Verifier {
  switch (entry.type) {
    case 'exact-answer':
      return new ExactAnswerVerifier(entry.id);
    case 'regex':
      return new RegexVerifier(entry.id, entry.pattern, entry.flags);
    case 'command':
      return new CommandVerifier(entry.id, { command: entry.command, timeoutMs: entry.timeoutMs, envAllowlist: entry.envAllowlist });
    case 'artifact-digest':
      return new ArtifactDigestVerifier(quarantine, entry.id);
  }
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Repository root (for resolving the bundled demo configuration). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
