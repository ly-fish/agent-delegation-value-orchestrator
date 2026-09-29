import { CancelledError, type Clock, deadlineSignal, type MetricsSink, noopMetrics, systemClock } from '@dvo/core';
import type { z } from 'zod';
import { A2aHttpError, A2aRpcError, A2aTransportError, classifyFetchFailure } from './errors.ts';
import { A2A_PROTOCOL_VERSION, type A2aMethod, JsonRpcResponseSchema } from './wire.ts';

export interface TransportOptions {
  fetch?: typeof fetch;
  clock?: Clock;
  /** Per-request timeout. */
  requestTimeoutMs: number;
  /** Responses larger than this are refused (defence against hostile peers). */
  maxResponseBytes: number;
  metrics?: MetricsSink;
  peerLabel: string;
}

export interface CallContext {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * JSON-RPC 2.0 over HTTP for the A2A v1.0 binding (spec §9). Adds `A2A-Version`, enforces a
 * per-request timeout and a response byte cap, validates the envelope and result shape,
 * and classifies every failure by whether the request may have been processed.
 */
export class JsonRpcHttpTransport {
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #options: TransportOptions;
  readonly #metrics: MetricsSink;
  #nextId = 1;

  constructor(options: TransportOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#options = options;
    this.#metrics = options.metrics ?? noopMetrics;
  }

  async call<T>(url: string, method: A2aMethod, params: unknown, schema: z.ZodType<T>, ctx: CallContext): Promise<T> {
    const id = this.#nextId++;
    const timeout = deadlineSignal(this.#clock, this.#clock.now() + this.#options.requestTimeoutMs, ctx.signal);
    const count = (outcome: string): void =>
      this.#metrics.inc('dvo_peer_requests_total', { peer: this.#options.peerLabel, method, outcome });
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'a2a-version': A2A_PROTOCOL_VERSION,
            'user-agent': 'dvo-a2a-bridge/0.1',
            ...ctx.headers,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          redirect: 'error',
          signal: timeout.signal,
        });
      } catch (error) {
        if (ctx.signal?.aborted) throw new CancelledError(`A2A ${method} aborted`);
        const phase = timeout.signal.aborted ? 'unknown' : classifyFetchFailure(error);
        count(phase === 'not_sent' ? 'not_sent' : 'unknown');
        throw new A2aTransportError(phase, `A2A ${method} transport failure`, { cause: error });
      }

      if (response.status === 429) {
        await response.body?.cancel();
        count('throttled');
        throw new A2aTransportError('not_sent', `A2A ${method} throttled`, { status: 429 });
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        count('http_5xx');
        throw new A2aTransportError('unknown', `A2A ${method} server error`, { status: response.status });
      }
      if (response.status >= 400) {
        await response.body?.cancel();
        count('http_4xx');
        throw new A2aHttpError(response.status, method);
      }

      let text: string;
      try {
        text = await readCapped(response, this.#options.maxResponseBytes);
      } catch (error) {
        count('unreadable');
        throw new A2aTransportError('unknown', `A2A ${method} response unreadable`, { cause: error });
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        count('invalid_json');
        throw new A2aTransportError('unknown', `A2A ${method} response is not JSON`, { retryable: false });
      }
      const envelope = JsonRpcResponseSchema.safeParse(body);
      if (!envelope.success || (envelope.data.id !== id && envelope.data.id !== null)) {
        count('invalid_envelope');
        throw new A2aTransportError('unknown', `A2A ${method} returned an invalid JSON-RPC envelope`, { retryable: false });
      }
      if (envelope.data.error !== undefined) {
        count(`rpc_${envelope.data.error.code}`);
        throw new A2aRpcError(envelope.data.error.code, method);
      }
      const result = schema.safeParse(envelope.data.result);
      if (!result.success) {
        count('invalid_result');
        throw new A2aTransportError('unknown', `A2A ${method} result does not match the v1.0 schema`, { retryable: false });
      }
      count('ok');
      return result.data;
    } finally {
      timeout.dispose();
    }
  }
}

/** Reads a response body as UTF-8, aborting once `maxBytes` is exceeded. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new RangeError('response too large');
  }
  if (response.body === null) return '';
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RangeError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
