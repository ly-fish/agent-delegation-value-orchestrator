import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const EXT = 'urn:research:dvo:evidence-envelope:v1';

type State =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_INPUT_REQUIRED';

export interface MockAnswer {
  statement: string;
  confidence?: number;
}

/** Knobs for the failure modes the bridge must survive (design §14 M2, §15 chaos). */
export interface MockPeerBehaviour {
  answer?: (text: string) => MockAnswer;
  /** GetTask polls that still report WORKING before the task reaches `finalState`. */
  workingPolls?: number;
  finalState?: State;
  /** How the answer is returned: DVO extension artifact, untagged data part, or plain text. */
  envelopeMode?: 'extension' | 'data' | 'text';
  declareExtension?: boolean;
  requiredExtensions?: string[];
  /** De-duplicate SendMessage by messageId (a peer under our control). The reference SDK does not. */
  dedupByMessageId?: boolean;
  cancel?: 'supported' | 'not_cancelable' | 'unsupported';
  /** The first N SendMessage calls fail this way. */
  sendFailure?: { mode: 'http500' | 'rpc_internal' | 'http429'; count: number };
  /** The first N GetTask calls return HTTP 500. */
  pollFailures?: number;
  /** A cancel on a running task races with its completion: the task completes and the cancel is refused. */
  completeOnCancel?: boolean;
  /** Explicit state reported by the n-th GetTask of each task (overrides workingPolls/finalState). */
  stateSequence?: State[];
  /** GetTask answers TaskNotFound. */
  loseTasks?: boolean;
  /** Extra text included in the answer (e.g. prompt-injection samples). */
  injectText?: string;
  /** Artifact URL parts to attach. */
  artifactUrls?: Array<{ url: string; mediaType?: string; sha256?: string; bytes?: number }>;
  /** Delay every JSON-RPC response by this much (real time). */
  responseDelayMs?: number;
  /** Override the JSON-RPC URL advertised in the card. */
  advertisedRpcUrl?: string;
  skills?: string[];
}

interface MockTask {
  id: string;
  contextId: string;
  messageId: string;
  state: State;
  polls: number;
  text: string;
  requestedTier: number;
}

export interface RecordedCall {
  method: string;
  params: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A spec-conformant A2A v1.0 JSON-RPC peer (Agent Card, SendMessage, GetTask, CancelTask)
 * on a loopback port, independent of the bridge's own wire code so contract tests cannot
 * share a bug with the implementation under test.
 */
export class MockA2aPeer {
  readonly calls: RecordedCall[] = [];
  readonly tasks = new Map<string, MockTask>();
  cardRequests = 0;
  #server: Server;
  #behaviour: MockPeerBehaviour;
  #sendCalls = 0;
  #getCalls = 0;
  url = '';

  private constructor(behaviour: MockPeerBehaviour) {
    this.#behaviour = behaviour;
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  static async start(behaviour: MockPeerBehaviour = {}): Promise<MockA2aPeer> {
    const peer = new MockA2aPeer(behaviour);
    await new Promise<void>((resolve) => peer.#server.listen(0, '127.0.0.1', resolve));
    peer.url = `http://127.0.0.1:${(peer.#server.address() as AddressInfo).port}`;
    return peer;
  }

  set behaviour(next: MockPeerBehaviour) {
    this.#behaviour = next;
  }

  get rpcUrl(): string {
    return `${this.url}/a2a/jsonrpc`;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }

  card(): Record<string, unknown> {
    const b = this.#behaviour;
    const extensions = [
      ...(b.declareExtension === false ? [] : [{ uri: EXT, description: 'DVO evidence envelope', required: false }]),
      ...(b.requiredExtensions ?? []).map((uri) => ({ uri, description: 'required', required: true })),
    ];
    return {
      name: 'mock-peer',
      description: 'Mock A2A v1.0 peer for tests',
      version: '1.0.0',
      supportedInterfaces: [{ url: b.advertisedRpcUrl ?? this.rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extensions },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json', 'text/plain'],
      skills: (b.skills ?? ['general', 'evidence-retrieval']).map((id) => ({ id, name: id, description: id, tags: [id] })),
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      this.cardRequests += 1;
      const body = JSON.stringify(this.card());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', etag: `"${body.length}"` });
      res.end(body);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/a2a/jsonrpc') {
      res.writeHead(404).end();
      return;
    }
    const raw = await readBody(req);
    let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      rpc = JSON.parse(raw) as typeof rpc;
    } catch {
      this.#reply(res, null, undefined, { code: -32700, message: 'Invalid JSON payload' });
      return;
    }
    this.calls.push({ method: rpc.method ?? '', params: rpc.params, headers: req.headers });
    if (this.#behaviour.responseDelayMs !== undefined) await new Promise((r) => setTimeout(r, this.#behaviour.responseDelayMs));
    if (req.headers['a2a-version'] !== '1.0') {
      this.#reply(res, rpc.id, undefined, { code: -32009, message: 'Version not supported' });
      return;
    }
    switch (rpc.method) {
      case 'SendMessage':
        return this.#send(res, rpc.id, rpc.params ?? {});
      case 'GetTask':
        return this.#get(res, rpc.id, idParam(rpc.params));
      case 'CancelTask':
        return this.#cancel(res, rpc.id, idParam(rpc.params));
      default:
        this.#reply(res, rpc.id, undefined, { code: -32601, message: 'Method not found' });
    }
  }

  #send(res: ServerResponse, id: unknown, params: Record<string, unknown>): void {
    const b = this.#behaviour;
    this.#sendCalls += 1;
    if (b.sendFailure !== undefined && this.#sendCalls <= b.sendFailure.count) {
      if (b.sendFailure.mode === 'http500') return void res.writeHead(500).end('boom');
      if (b.sendFailure.mode === 'http429') return void res.writeHead(429).end('slow down');
      return this.#reply(res, id, undefined, { code: -32603, message: 'Internal error' });
    }
    const message = params['message'] as
      { messageId?: string; parts?: Array<{ text?: string }>; metadata?: Record<string, { requestedTier?: number }> } | undefined;
    if (message?.messageId === undefined || !Array.isArray(message.parts) || message.parts.length === 0) {
      return this.#reply(res, id, undefined, { code: -32602, message: 'Invalid parameters' });
    }
    if (b.dedupByMessageId === true) {
      const existing = [...this.tasks.values()].find((t) => t.messageId === message.messageId);
      if (existing !== undefined) return this.#reply(res, id, { task: this.#view(existing) });
    }
    const task: MockTask = {
      id: randomUUID(),
      contextId: randomUUID(),
      messageId: message.messageId,
      state: 'TASK_STATE_SUBMITTED',
      polls: 0,
      text: message.parts.map((p) => p.text ?? '').join('\n'),
      requestedTier: message.metadata?.[EXT]?.requestedTier ?? 0,
    };
    this.tasks.set(task.id, task);
    this.#reply(res, id, { task: this.#view(task) });
  }

  #get(res: ServerResponse, id: unknown, taskId: string): void {
    const b = this.#behaviour;
    this.#getCalls += 1;
    if (b.pollFailures !== undefined && this.#getCalls <= b.pollFailures) return void res.writeHead(500).end('boom');
    const task = this.tasks.get(taskId);
    if (task === undefined || b.loseTasks === true) return this.#reply(res, id, undefined, { code: -32001, message: 'Task not found' });
    task.polls += 1;
    if (b.stateSequence !== undefined) {
      const scripted = b.stateSequence[Math.min(task.polls - 1, b.stateSequence.length - 1)]!;
      if (!isTerminal(task.state)) task.state = scripted;
      // A scripted regression is reported as-is (a buggy or replayed peer), without changing the task.
      return this.#reply(res, id, { ...this.#view(task), status: { state: scripted }, ...(isTerminal(scripted) ? {} : { artifacts: [] }) });
    }
    if (isTerminal(task.state)) {
      // Terminal tasks keep reporting their terminal state.
    } else if (task.polls > (b.workingPolls ?? 1)) {
      task.state = b.finalState ?? 'TASK_STATE_COMPLETED';
    } else {
      task.state = 'TASK_STATE_WORKING';
    }
    this.#reply(res, id, this.#view(task));
  }

  #cancel(res: ServerResponse, id: unknown, taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) return this.#reply(res, id, undefined, { code: -32001, message: 'Task not found' });
    const mode = this.#behaviour.cancel ?? 'supported';
    if (this.#behaviour.completeOnCancel === true && !isTerminal(task.state)) {
      task.state = 'TASK_STATE_COMPLETED';
      const { stateSequence: _dropped, ...rest } = this.#behaviour;
      this.#behaviour = rest;
      return this.#reply(res, id, undefined, { code: -32002, message: 'Task not cancelable' });
    }
    if (mode === 'unsupported') return this.#reply(res, id, undefined, { code: -32004, message: 'Unsupported operation' });
    if (mode === 'not_cancelable' || isTerminal(task.state))
      return this.#reply(res, id, undefined, { code: -32002, message: 'Task not cancelable' });
    task.state = 'TASK_STATE_CANCELED';
    this.#reply(res, id, this.#view(task));
  }

  #view(task: MockTask): Record<string, unknown> {
    const view: Record<string, unknown> = { id: task.id, contextId: task.contextId, status: { state: task.state } };
    if (task.state === 'TASK_STATE_COMPLETED') view['artifacts'] = this.#artifacts(task);
    if (task.state === 'TASK_STATE_FAILED' || task.state === 'TASK_STATE_REJECTED') {
      view['status'] = {
        state: task.state,
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'peer could not do it' }] },
      };
    }
    return view;
  }

  #artifacts(task: MockTask): unknown[] {
    const b = this.#behaviour;
    const answer = (b.answer ?? (() => ({ statement: '42', confidence: 0.9 })))(task.text);
    const statement = b.injectText === undefined ? answer.statement : `${answer.statement}\n${b.injectText}`;
    const urls = (b.artifactUrls ?? []).map((a) => ({
      url: a.url,
      mediaType: a.mediaType ?? 'application/json',
      filename: 'artifact.json',
      metadata: { ...(a.sha256 === undefined ? {} : { sha256: a.sha256 }), ...(a.bytes === undefined ? {} : { bytes: a.bytes }) },
    }));
    const envelope = {
      schemaVersion: '1.0',
      tier: task.requestedTier,
      taskScope: task.text.slice(0, 200),
      claims: [{ id: 'answer', statement, confidence: answer.confidence ?? 0.9, assumptions: [], dependencies: [], status: 'verified' }],
      evidence: [{ kind: 'observation', summary: 'mock peer computation' }],
      unexpectedField: 'should be stripped',
    };
    switch (b.envelopeMode ?? 'extension') {
      case 'extension':
        return [
          {
            artifactId: 'evidence',
            name: 'evidence',
            extensions: [EXT],
            parts: [{ data: envelope, mediaType: 'application/json' }, ...urls],
          },
        ];
      case 'data':
        return [{ artifactId: 'evidence', parts: [{ data: envelope, mediaType: 'application/json' }] }];
      case 'text':
        return [{ artifactId: 'answer', parts: [{ text: statement }, ...urls] }];
    }
  }

  #reply(res: ServerResponse, id: unknown, result?: unknown, error?: { code: number; message: string }): void {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...(error === undefined ? { result } : { error }) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  }
}

function idParam(params: Record<string, unknown> | undefined): string {
  const id = params?.['id'];
  return typeof id === 'string' ? id : '';
}

function isTerminal(state: State): boolean {
  return (
    state === 'TASK_STATE_COMPLETED' || state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_CANCELED' || state === 'TASK_STATE_REJECTED'
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
