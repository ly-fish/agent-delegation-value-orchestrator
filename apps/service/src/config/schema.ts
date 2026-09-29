import { z } from 'zod';

const secretRef = z.string().regex(/^secret:\/\/[a-z0-9][a-z0-9/_.-]*$/i, 'must be a secret:// reference');
const positiveInt = z.number().int().positive();
const nonNegative = z.number().nonnegative();
const trustTier = z.enum(['public', 'internal', 'restricted']);
const classification = z.enum(['public', 'internal', 'restricted', 'secret']);

/** configs/peers.yaml — design appendix B. */
export const PeerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'peer ids are lowercase slugs'),
  endpoint: z.url(),
  allowed: z.boolean(),
  trustTier,
  maxConcurrency: positiveInt.default(2),
  timeoutMs: positiveInt.default(60_000),
  requestTimeoutMs: positiveInt.default(15_000),
  maxArtifactBytes: positiveInt.default(5 * 1024 * 1024),
  allowedSkills: z.array(z.string()).default([]),
  credentialsRef: secretRef.optional(),
  authScheme: z.enum(['bearer', 'api-key', 'none']).default('none'),
  apiKeyHeader: z.string().default('x-api-key'),
  extensionUris: z.array(z.string()).default([]),
  dedupSupported: z.boolean().default(false),
  allowRestricted: z.boolean().default(false),
  costPerCallUsd: nonNegative.default(0.01),
  artifactHosts: z.array(z.string()).optional(),
  artifactMimeTypes: z.array(z.string()).optional(),
  allowInsecureLoopback: z.boolean().default(false),
  poll: z
    .object({ initialDelayMs: positiveInt, maxDelayMs: positiveInt, multiplier: z.number().min(1) })
    .default({ initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 1.6 }),
  cardTtlMs: positiveInt.default(300_000),
});
export const PeersFileSchema = z.object({ peers: z.array(PeerSchema).default([]) }).strict();

const VerifierSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('exact-answer') }),
  z.object({ id: z.string(), type: z.literal('regex'), pattern: z.string().max(500), flags: z.string().default('') }),
  z.object({
    id: z.string(),
    type: z.literal('command'),
    command: z.array(z.string()).min(1),
    timeoutMs: positiveInt.default(30_000),
    envAllowlist: z.array(z.string()).default([]),
  }),
  z.object({ id: z.string(), type: z.literal('artifact-digest') }),
]);

const budgetShape = z.object({
  maxCostUsd: nonNegative,
  maxInputTokens: positiveInt,
  maxOutputTokens: positiveInt,
  maxRemoteCalls: z.number().int().nonnegative(),
  maxParallelAttempts: positiveInt,
  deadlineMs: positiveInt,
});

/** configs/service.yaml — process, storage, ingress limits, verifiers. */
export const ServiceFileSchema = z
  .object({
    http: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(0).max(65535).default(8080),
        apiTokenRef: secretRef.optional(),
        bodyLimitBytes: positiveInt.default(256 * 1024),
        protectMetrics: z.boolean().default(false),
      })
      .default({ host: '127.0.0.1', port: 8080, bodyLimitBytes: 256 * 1024, protectMetrics: false }),
    storage: z
      .object({ sqlitePath: z.string().default('.data/dvo.db'), quarantineDir: z.string().default('.data/quarantine') })
      .default({ sqlitePath: '.data/dvo.db', quarantineDir: '.data/quarantine' }),
    secrets: z
      .object({ dir: z.string().optional(), envPrefix: z.string().default('HARNESS_SECRET_') })
      .default({ envPrefix: 'HARNESS_SECRET_' }),
    logging: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info') }).default({ level: 'info' }),
    scheduler: z
      .object({ globalConcurrency: positiveInt.default(16), cancelGraceMs: positiveInt.default(5_000) })
      .default({ globalConcurrency: 16, cancelGraceMs: 5_000 }),
    ingress: z
      .object({
        maxGoalChars: positiveInt.default(20_000),
        defaultClassification: classification.default('internal'),
        defaultSuccessValueUsd: nonNegative.default(1),
        maxSuccessValueUsd: nonNegative.default(100),
        defaults: budgetShape,
        ceilings: budgetShape,
      })
      .optional(),
    local: z
      .object({
        enabled: z.boolean().default(true),
        costEstimateUsd: nonNegative.default(0.002),
        timeoutMs: positiveInt.default(300_000),
        maxConcurrency: positiveInt.default(2),
        skills: z.array(z.string()).default(['general']),
      })
      .default({ enabled: true, costEstimateUsd: 0.002, timeoutMs: 300_000, maxConcurrency: 2, skills: ['general'] }),
    verifiers: z.array(VerifierSchema).default([{ id: 'exact-answer', type: 'exact-answer' }]),
  })
  .strict();

/** configs/policy.yaml — DVO policy, engine behaviour, circuit breakers, reliability priors. */
export const PolicyFileSchema = z
  .object({
    policy: z
      .object({
        version: z.string().optional(),
        minEscalationWindowMs: positiveInt.optional(),
        latencyCostUsdPerSecond: nonNegative.optional(),
        maxLocalAttempts: positiveInt.optional(),
        maxAttemptsPerPeer: positiveInt.optional(),
        retryCorrelation: z.number().min(0).max(1).optional(),
        depthPenalty: z.number().min(0).max(1).optional(),
        couplingMaxForDelegate: z.number().min(0).max(1).optional(),
        couplingMaxForParallel: z.number().min(0).max(1).optional(),
        parallelMaxWidth: positiveInt.optional(),
        sufficientConfidence: z.number().min(0).max(1).optional(),
        trustPenalty: z.object({ public: nonNegative, internal: nonNegative, restricted: nonNegative }).partial().optional(),
        halfOpenPenalty: nonNegative.optional(),
        evidenceInformativeness: z.number().min(0).max(1).optional(),
        minNetValueUsd: z.number().optional(),
        exploration: z
          .object({ enabled: z.boolean(), epsilon: z.number().min(0).max(1), seed: z.number().int() })
          .partial()
          .optional(),
      })
      .default({}),
    engine: z
      .object({
        acceptLateResults: z.boolean(),
        maxDecisions: positiveInt,
        verifierTimeoutMs: positiveInt,
        defaultSkill: z.string(),
        latencyPriorFraction: z.number().min(0).max(1),
        capabilityTtlMs: positiveInt,
      })
      .partial()
      .default({}),
    circuit: z
      .object({ failureThreshold: positiveInt, cooldownMs: positiveInt, halfOpenMaxProbes: positiveInt, successThreshold: positiveInt })
      .default({ failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxProbes: 1, successThreshold: 1 }),
    reliability: z
      .object({
        localPrior: z.tuple([nonNegative, nonNegative]),
        peerPrior: z.tuple([nonNegative, nonNegative]),
        calibratorWeight: z.number().min(0).max(1),
        calibratorHalfLife: positiveInt,
      })
      .default({ localPrior: [3, 2], peerPrior: [1, 1], calibratorWeight: 0.3, calibratorHalfLife: 10 }),
  })
  .strict();

/** configs/runtime-lock.yaml — pinned runtime versions (design §8.3, §14 M0, §18). */
export const RuntimeLockFileSchema = z
  .object({
    node: z.string(),
    image: z.string().optional(),
    a2a: z.object({ protocolVersions: z.array(z.string().regex(/^\d+\.\d+$/)).min(1), sdkReference: z.string().optional() }),
    dsh: z.object({
      command: z.array(z.string()).min(1),
      expectedVersion: z.string(),
      commit: z.string().optional(),
      profile: z.string().default('headless'),
      patchFiles: z.array(z.string()).default([]),
      modelRoute: z.string(),
      toolAllowlist: z.array(z.string()).default([]),
      pricing: z.object({ inputPerMTokUsd: nonNegative, outputPerMTokUsd: nonNegative }),
      envAllowlist: z.array(z.string()).default(['PATH', 'HOME', 'LANG', 'TZ', 'DSH_HOME']),
      credentialEnv: z.array(z.object({ name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), ref: secretRef })).default([]),
      versionArgs: z.array(z.string()).default(['--version']),
      enforceVersion: z.boolean().default(true),
      workdir: z.string().default('.'),
      maxFinalBytes: positiveInt.default(1024 * 1024),
      killGraceMs: positiveInt.default(5_000),
    }),
  })
  .strict();

export type PeerFileEntry = z.infer<typeof PeerSchema>;
export type ServiceFile = z.infer<typeof ServiceFileSchema>;
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
export type RuntimeLockFile = z.infer<typeof RuntimeLockFileSchema>;
export type VerifierEntry = z.infer<typeof VerifierSchema>;
