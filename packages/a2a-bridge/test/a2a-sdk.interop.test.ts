/**
 * Interoperability with the official A2A JavaScript SDK (@a2a-js/sdk 1.2, spec v1.0) as the
 * reference server (design §15 "契约测试: mock 与真实参考实现均通过").
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { AgentEvent, type AgentExecutor, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A2aPeerExecutor, AgentCardResolver } from '@dvo/a2a-bridge';
import { chaosFetch, MemoryOutbox } from '@dvo/testkit';
import { PeerId } from '@dvo/core';
import { execute, request, testPeer } from './helpers.ts';

const EXT = 'urn:research:dvo:evidence-envelope:v1';
let server: Server;
let base = '';
let sendCount = 0;
const cancelled = new Set<string>();

const dataPart = (value: unknown) => ({
  content: { $case: 'data' as const, value },
  mediaType: 'application/json',
  metadata: undefined,
  filename: '',
});

const executor: AgentExecutor = {
  async execute(ctx, bus) {
    sendCount += 1;
    const text = ctx.userMessage.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join(' ');
    bus.publish(
      AgentEvent.task({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
        artifacts: [],
        history: [ctx.userMessage],
        metadata: undefined,
      }),
    );
    const slow = text.includes('slow');
    for (let i = 0; i < (slow ? 200 : 2); i++) {
      if (cancelled.has(ctx.taskId)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: 'evidence',
          name: 'evidence',
          description: '',
          parts: [
            dataPart({
              schemaVersion: '1.0',
              tier: 1,
              taskScope: 'interop',
              claims: [{ id: 'answer', statement: '42', confidence: 0.8, status: 'proposed' }],
              evidence: [],
            }),
          ],
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
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
        metadata: undefined,
      }),
    );
  },
  async cancelTask(taskId, bus) {
    cancelled.add(taskId);
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: undefined },
        metadata: undefined,
      }),
    );
  },
};

beforeAll(async () => {
  const app = express();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const card = {
    name: 'sdk-reference-peer',
    description: 'Official @a2a-js/sdk server',
    version: '1.0.0',
    supportedInterfaces: [{ url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: undefined,
    documentationUrl: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [{ uri: EXT, description: 'DVO evidence', required: false, params: undefined }],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'general',
        name: 'general',
        description: 'general',
        tags: ['general'],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
    iconUrl: undefined,
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('interop with the official A2A v1.0 SDK server', () => {
  it('discovers the card and completes a task with a DVO envelope artifact', async () => {
    const profile = await new AgentCardResolver().resolve(testPeer(base));
    expect(profile.protocolVersion).toBe('1.0');
    expect(profile.supportsEvidenceExtension).toBe(true);
    const { result } = await execute(testPeer(base), request());
    expect(result.terminalStatus).toBe('completed');
    expect(result.output!.claims[0]!.statement).toBe('42');
    expect(result.output!.tier).toBe(1);
  });

  it('cancels a running task through CancelTask', async () => {
    const ledger = new MemoryOutbox();
    const peerExecutor = new A2aPeerExecutor(testPeer(base), { resolver: new AgentCardResolver(), ledger });
    const req = request({ prompt: 'Task: slow job' });
    const prepared = await peerExecutor.prepare(req);
    ledger.insert({
      attemptId: req.correlation.attemptId!,
      taskId: req.correlation.taskId,
      peerId: PeerId('peer-test'),
      state: 'pending',
      requestDigest: prepared.requestDigest,
      idempotencyKey: 'k',
      payload: prepared.payload,
      sendCount: 0,
      createdAt: 'n',
      updatedAt: 'n',
    });
    const handle = await peerExecutor.start(req);
    await new Promise((r) => setTimeout(r, 150));
    await handle.cancel('interop');
    expect((await handle.result()).terminalStatus).toBe('cancelled');
  });

  it('the reference server does not de-duplicate by messageId, so unknown submissions are not resent', async () => {
    const before = sendCount;
    const fetch = chaosFetch({ resetAfterSendFirst: 1, method: 'SendMessage' });
    const { result } = await execute(testPeer(base, { dedupSupported: false }), request(), { fetch });
    await new Promise((r) => setTimeout(r, 100));
    expect(result.diagnostics[0]!.code).toBe('submission_unknown');
    expect(sendCount - before).toBe(1);
  });
});
