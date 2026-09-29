import { HarnessError } from '@dvo/core';

/** A2A-specific JSON-RPC error codes (spec §5.4). */
export const A2A_ERROR_CODES = {
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  ExtendedAgentCardNotConfiguredError: -32007,
  ExtensionSupportRequiredError: -32008,
  VersionNotSupportedError: -32009,
} as const;

export type A2aErrorType =
  | keyof typeof A2A_ERROR_CODES
  | 'JSONParseError'
  | 'InvalidRequestError'
  | 'MethodNotFoundError'
  | 'InvalidParamsError'
  | 'InternalError'
  | 'UnknownError';

export function errorTypeFromCode(code: number): A2aErrorType {
  const entry = Object.entries(A2A_ERROR_CODES).find(([, c]) => c === code);
  if (entry !== undefined) return entry[0] as A2aErrorType;
  switch (code) {
    case -32700:
      return 'JSONParseError';
    case -32600:
      return 'InvalidRequestError';
    case -32601:
      return 'MethodNotFoundError';
    case -32602:
      return 'InvalidParamsError';
    case -32603:
      return 'InternalError';
    default:
      return 'UnknownError';
  }
}

/** The peer answered with a JSON-RPC error: the request was received and definitively rejected. */
export class A2aRpcError extends HarnessError {
  readonly rpcCode: number;
  readonly a2aType: A2aErrorType;

  constructor(rpcCode: number, method: string) {
    const a2aType = errorTypeFromCode(rpcCode);
    super('protocol_error', `A2A ${method} failed: ${a2aType}`, {
      retryable: a2aType === 'InternalError',
      details: { rpcCode, a2aType, method },
    });
    this.rpcCode = rpcCode;
    this.a2aType = a2aType;
  }
}

/**
 * Where a transport failure happened, which decides whether a SendMessage may be retried:
 *  - `not_sent`: the request provably never reached the peer (connect refused, DNS, 429) → safe;
 *  - `unknown`: it may have been processed (timeout, reset, 5xx, unreadable body) → never
 *    blindly resent to a peer that does not de-duplicate (design §10.2).
 */
export type DeliveryPhase = 'not_sent' | 'unknown';

export class A2aTransportError extends HarnessError {
  readonly phase: DeliveryPhase;
  readonly status: number | undefined;

  constructor(phase: DeliveryPhase, safeMessage: string, options: { status?: number; cause?: unknown; retryable?: boolean } = {}) {
    super(phase === 'not_sent' ? 'protocol_error' : 'submission_unknown', safeMessage, {
      retryable: options.retryable ?? true,
      cause: options.cause,
      details: { phase, ...(options.status === undefined ? {} : { status: options.status }) },
    });
    this.phase = phase;
    this.status = options.status;
  }
}

/** Definite, non-retryable HTTP-level refusal (auth, not found, payload rejected). */
export class A2aHttpError extends HarnessError {
  readonly status: number;

  constructor(status: number, method: string) {
    super(status === 401 || status === 403 ? 'peer_not_allowed' : 'protocol_error', `A2A ${method} rejected with HTTP ${status}`, {
      retryable: false,
      details: { status, method },
    });
    this.status = status;
  }
}

const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Classifies a `fetch` rejection by the undici/libuv error code in its cause chain. */
export function classifyFetchFailure(error: unknown): DeliveryPhase {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return 'not_sent';
    current = (current as { cause?: unknown }).cause;
  }
  return 'unknown';
}
