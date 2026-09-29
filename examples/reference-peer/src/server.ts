/**
 * Reference A2A v1.0 peer for demos, built on the official @a2a-js/sdk server.
 * It "solves" tasks that contain one arithmetic expression (e.g. "What is 17 * 23?") and
 * answers with a DVO EvidenceEnvelope artifact tagged with the extension URI.
 *
 *   PORT=9100 HOST=127.0.0.1 node examples/reference-peer/src/server.ts
 */
import express from 'express';
import { AgentEvent, type AgentExecutor, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';

const EXT = 'urn:research:dvo:evidence-envelope:v1';
const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 9100);
const publicUrl = process.env['PUBLIC_URL'] ?? `http://${host}:${port}`;

function solve(text: string): { statement: string; confidence: number } {
  const m = /(-?\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (m === null) return { statement: 'I can only evaluate a single arithmetic expression.', confidence: 0.05 };
  const [a, op, b] = [Number(m[1]), m[2], Number(m[3])];
  const value = op === '+' ? a + b : op === '-' ? a - b : op === '/' ? a / b : a * b;
  return { statement: String(Number.isInteger(value) ? value : Number(value.toFixed(6))), confidence: 0.95 };
}

const status = (state: TaskState) => ({ state, message: undefined, timestamp: new Date().toISOString() });

const executor: AgentExecutor = {
  async execute(ctx, bus) {
    const text = ctx.userMessage.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('\n');
    bus.publish(
      AgentEvent.task({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: status(TaskState.TASK_STATE_WORKING),
        artifacts: [],
        history: [ctx.userMessage],
        metadata: undefined,
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const answer = solve(text);
    const envelope = {
      schemaVersion: '1.0',
      tier: 1,
      taskScope: text.split('\n')[0]?.slice(0, 200) ?? '',
      claims: [
        {
          id: 'answer',
          statement: answer.statement,
          confidence: answer.confidence,
          assumptions: ['exact arithmetic'],
          dependencies: [],
          status: 'proposed',
        },
      ],
      evidence: [{ kind: 'tool-result', summary: 'evaluated with the reference calculator' }],
    };
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: 'evidence',
          name: 'evidence',
          description: '',
          parts: [{ content: { $case: 'data', value: envelope }, mediaType: 'application/json', metadata: undefined, filename: '' }],
          metadata: undefined,
          extensions: [EXT],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: status(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      }),
    );
  },
  async cancelTask(taskId, bus) {
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId: '', status: status(TaskState.TASK_STATE_CANCELED), metadata: undefined }));
  },
};

const card = {
  name: 'dvo-reference-peer',
  description: 'Arithmetic reference peer (official @a2a-js/sdk server)',
  version: '0.1.0',
  supportedInterfaces: [{ url: `${publicUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
  provider: undefined,
  documentationUrl: undefined,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [{ uri: EXT, description: 'DVO evidence envelope', required: false, params: undefined }],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'general',
      name: 'arithmetic',
      description: 'Evaluates one arithmetic expression',
      tags: ['math'],
      examples: ['What is 17 * 23?'],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  signatures: [],
  iconUrl: undefined,
};

const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
const app = express();
app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.listen(port, host, () => process.stdout.write(`reference peer listening on ${publicUrl}\n`));
