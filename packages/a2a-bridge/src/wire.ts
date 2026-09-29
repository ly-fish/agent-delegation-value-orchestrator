import { z } from 'zod';

/**
 * A2A v1.0 wire objects (a2a-protocol.org/v1.0.0, `lf.a2a.v1`), JSON-RPC binding, ProtoJSON
 * camelCase. Parsing is tolerant of unknown fields (they are stripped) so newer peers
 * interoperate, and strict on what the bridge relies on.
 */
export const A2A_PROTOCOL_VERSION = '1.0';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const JSONRPC_BINDING = 'JSONRPC';

/** Extension through which EvidenceEnvelopes and the idempotency key travel (design §9.3). */
export const EVIDENCE_EXTENSION_URI = 'urn:research:dvo:evidence-envelope:v1';

export const TASK_STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
export const INTERRUPTED_TASK_STATES: ReadonlySet<TaskState> = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);

/** Progress rank used to refuse out-of-order observations (a lower rank never replaces a higher one). */
export function stateRank(state: TaskState): number {
  if (TERMINAL_TASK_STATES.has(state)) return 3;
  if (INTERRUPTED_TASK_STATES.has(state)) return 2;
  if (state === 'TASK_STATE_WORKING') return 1;
  return 0;
}

const Metadata = z.record(z.string(), z.unknown());

/** Exactly one of text / raw / url / data (v1.0 has no `kind` discriminator). */
export const PartSchema = z
  .object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    metadata: Metadata.optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .refine((p) => [p.text, p.raw, p.url, p.data].filter((v) => v !== undefined).length === 1, {
    message: 'a Part must carry exactly one of text, raw, url or data',
  });
export type Part = z.infer<typeof PartSchema>;

export const MessageSchema = z.object({
  messageId: z.string().min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: z.enum(['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT']),
  parts: z.array(PartSchema),
  metadata: Metadata.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TaskStatusSchema = z.object({
  state: z.enum(TASK_STATES),
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(PartSchema),
  metadata: Metadata.optional(),
  extensions: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().optional(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: Metadata.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const SendMessageResponseSchema = z
  .object({ task: TaskSchema.optional(), message: MessageSchema.optional() })
  .refine((r) => (r.task === undefined) !== (r.message === undefined), { message: 'exactly one of task or message' });

export const AgentInterfaceSchema = z.object({
  url: z.string().min(1),
  protocolBinding: z.string().min(1),
  protocolVersion: z.string().min(1),
  tenant: z.string().optional(),
});

export const AgentExtensionSchema = z.object({
  uri: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: Metadata.optional(),
});

export const AgentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

export const AgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  supportedInterfaces: z.array(AgentInterfaceSchema).min(1),
  provider: z.object({ url: z.string(), organization: z.string() }).optional(),
  version: z.string(),
  documentationUrl: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extensions: z.array(AgentExtensionSchema).optional(),
    extendedAgentCard: z.boolean().optional(),
  }),
  securitySchemes: Metadata.optional(),
  securityRequirements: z.array(z.unknown()).optional(),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(AgentSkillSchema),
  signatures: z.array(z.unknown()).optional(),
  iconUrl: z.string().optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type A2aMethod = 'SendMessage' | 'GetTask' | 'CancelTask';
