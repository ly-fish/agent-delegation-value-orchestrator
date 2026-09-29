/**
 * The `dsh --profile headless --json` event stream (DSH 0.2.x, `packages/bundle/headless`):
 * newline-delimited JSON on stdout, opening with `session` and closing with `final`
 * (or `error` for failures outside a turn). Non-final lines are capped at 32 KiB by DSH.
 *
 * Only the fields the bridge relies on are modelled; unknown event types are ignored for
 * forward compatibility. `thinking` events are recognised solely so they can be dropped:
 * raw reasoning never leaves this module (invariant 6).
 */
export interface HeadlessUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export type HeadlessEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'status';
      phase: 'turn_start' | 'step_start' | 'step_end' | 'turn_end';
      usage?: HeadlessUsage;
      reason?: string;
      error?: HeadlessError;
    }
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'tool_result'; status: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string; code?: string };

/** Provider/runtime error attached to a structured turn-end reason. */
export interface HeadlessError {
  message: string;
  code?: string;
}

/** DSH turn-end reasons (mirrors `SubagentStopReason`); unknown values are treated as failures. */
export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';

export function parseHeadlessLine(line: string): HeadlessEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const e = value as Record<string, unknown>;
  switch (e['type']) {
    case 'session':
      return typeof e['sessionId'] === 'string' ? { type: 'session', sessionId: e['sessionId'] } : undefined;
    case 'status': {
      const phase = e['phase'];
      if (phase !== 'turn_start' && phase !== 'step_start' && phase !== 'step_end' && phase !== 'turn_end') return undefined;
      const usage = parseUsage(e['usage']);
      const { reason, error } = parseReason(e['reason']);
      return {
        type: 'status',
        phase,
        ...(usage === undefined ? {} : { usage }),
        ...(reason === undefined ? {} : { reason }),
        ...(error === undefined ? {} : { error }),
      };
    }
    case 'text':
      return { type: 'text' };
    case 'thinking':
      return { type: 'thinking' };
    case 'tool_call':
      return { type: 'tool_call', tool: typeof e['tool'] === 'string' ? e['tool'].slice(0, 128) : 'unknown' };
    case 'tool_result':
      return { type: 'tool_result', status: typeof e['status'] === 'string' ? e['status'] : 'unknown' };
    case 'final':
      return typeof e['text'] === 'string' ? { type: 'final', text: e['text'] } : undefined;
    case 'error':
      return {
        type: 'error',
        message: typeof e['message'] === 'string' ? e['message'].slice(0, 2048) : 'error',
        ...(typeof e['code'] === 'string' ? { code: e['code'].slice(0, 64) } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * DSH 0.2.0-rc.1 reports `turn_end.reason` either as a bare string ("completed") or as a
 * structured object, e.g. `{"kind":"error","error":{"message":"…","code":"MISSING_CREDENTIAL"}}`.
 */
function parseReason(value: unknown): { reason?: string; error?: HeadlessError } {
  if (typeof value === 'string') return { reason: value };
  if (value === null || typeof value !== 'object') return {};
  const r = value as Record<string, unknown>;
  const kind = typeof r['kind'] === 'string' ? r['kind'] : undefined;
  const raw = r['error'];
  let error: HeadlessError | undefined;
  if (raw !== null && typeof raw === 'object') {
    const err = raw as Record<string, unknown>;
    error = {
      message: typeof err['message'] === 'string' ? err['message'].slice(0, 2048) : 'error',
      ...(typeof err['code'] === 'string' ? { code: err['code'].slice(0, 64) } : {}),
    };
  }
  return { ...(kind === undefined ? {} : { reason: kind }), ...(error === undefined ? {} : { error }) };
}

function parseUsage(value: unknown): HeadlessUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const u = value as Record<string, unknown>;
  if (typeof u['inputTokens'] !== 'number' || typeof u['outputTokens'] !== 'number') return undefined;
  return {
    inputTokens: u['inputTokens'],
    outputTokens: u['outputTokens'],
    ...(typeof u['reasoningTokens'] === 'number' ? { reasoningTokens: u['reasoningTokens'] } : {}),
  };
}

/** Splits a byte stream into lines, enforcing a per-line cap (oversized lines are reported, not buffered). */
export class LineSplitter {
  #buffer = '';
  #oversized = false;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: string, onLine: (line: string) => void, onOversized: () => void): void {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) {
        if (!this.#oversized) {
          this.#buffer += rest;
          if (Buffer.byteLength(this.#buffer) > this.#maxBytes) {
            this.#buffer = '';
            this.#oversized = true;
            onOversized();
          }
        }
        return;
      }
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.#oversized) {
        this.#oversized = false;
        continue;
      }
      const line = this.#buffer + piece;
      this.#buffer = '';
      if (Buffer.byteLength(line) > this.#maxBytes) onOversized();
      else if (line.trim() !== '') onLine(line);
    }
  }

  flush(onLine: (line: string) => void): void {
    if (!this.#oversized && this.#buffer.trim() !== '') onLine(this.#buffer);
    this.#buffer = '';
  }
}
