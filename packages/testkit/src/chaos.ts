import type {
  ExecutionHandle,
  ExecutionObserver,
  ExecutionProgress,
  ExecutionRequest,
  Executor,
  ExecutorCapabilities,
  ExecutorKind,
  NormalizedExecutionResult,
  PreparedSubmission,
  ResumeRef,
} from '@dvo/core';

/** A `fetch` rejection that looks like undici's, with a libuv error code in `cause`. */
export function networkError(code: 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT'): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

export interface ChaosFetchOptions {
  /** Reject the first N requests before they are sent (connection refused). */
  refuseFirst?: number;
  /** Send the first N requests to the server, then drop the response (connection reset). */
  resetAfterSendFirst?: number;
  /** Only apply to requests whose JSON-RPC method matches. */
  method?: string;
}

/**
 * Wraps `fetch` to inject network faults. `resetAfterSend` is the nasty one: the peer
 * *does* process the request, but the client cannot know — exactly the "submission state
 * unknown" case of design §10.2.
 */
export function chaosFetch(options: ChaosFetchOptions, inner: typeof fetch = fetch): typeof fetch & { refused: number; reset: number } {
  let refused = 0;
  let reset = 0;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const matches = options.method === undefined || body.includes(`"method":"${options.method}"`);
    if (matches && refused < (options.refuseFirst ?? 0)) {
      refused += 1;
      wrapped.refused = refused;
      throw networkError('ECONNREFUSED');
    }
    if (matches && reset < (options.resetAfterSendFirst ?? 0)) {
      reset += 1;
      wrapped.reset = reset;
      const response = await inner(input, init);
      await response.body?.cancel();
      throw networkError('ECONNRESET');
    }
    return inner(input, init);
  }) as typeof fetch & { refused: number; reset: number };
  wrapped.refused = 0;
  wrapped.reset = 0;
  return wrapped;
}

export interface ChaosExecutorOptions {
  /** Deliver every progress notification twice. */
  duplicateProgress?: boolean;
  /** Also deliver a stale `remote_state` after the result. */
  staleProgressAfterResult?: boolean;
}

/** Wraps an executor to duplicate and reorder its progress notifications. */
export class ChaosExecutor implements Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly #inner: Executor;
  readonly #options: ChaosExecutorOptions;

  constructor(inner: Executor, options: ChaosExecutorOptions) {
    this.#inner = inner;
    this.#options = options;
    this.id = inner.id;
    this.kind = inner.kind;
  }

  capabilities(): Promise<ExecutorCapabilities> {
    return this.#inner.capabilities();
  }

  async prepare(request: ExecutionRequest): Promise<PreparedSubmission> {
    if (this.#inner.prepare === undefined) return { payload: {}, requestDigest: 'none' };
    return this.#inner.prepare(request);
  }

  async start(request: ExecutionRequest, observer?: ExecutionObserver): Promise<ExecutionHandle> {
    return this.#wrap(await this.#inner.start(request, this.#observer(observer)), observer);
  }

  async resume(ref: ResumeRef, observer?: ExecutionObserver): Promise<ExecutionHandle> {
    if (this.#inner.resume === undefined) return this.start(ref.request, observer);
    return this.#wrap(await this.#inner.resume(ref, this.#observer(observer)), observer);
  }

  #observer(observer: ExecutionObserver | undefined): ExecutionObserver {
    return {
      onProgress: (p: ExecutionProgress) => {
        observer?.onProgress(p);
        if (this.#options.duplicateProgress === true) observer?.onProgress(p);
      },
    };
  }

  #wrap(handle: ExecutionHandle, observer: ExecutionObserver | undefined): ExecutionHandle {
    return {
      attemptId: handle.attemptId,
      cancel: (reason) => handle.cancel(reason),
      result: async (): Promise<NormalizedExecutionResult> => {
        const result = await handle.result();
        if (this.#options.staleProgressAfterResult === true) {
          setImmediate(() => observer?.onProgress({ kind: 'remote_state', state: 'TASK_STATE_WORKING' }));
        }
        return result;
      },
    };
  }
}
