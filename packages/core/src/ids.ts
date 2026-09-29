import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.ts';

declare const brand: unique symbol;

/** Nominal typing for string identifiers so a TaskId can never be passed where an AttemptId is expected. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type TraceId = Brand<string, 'TraceId'>;
export type EventId = Brand<string, 'EventId'>;
export type PeerId = Brand<string, 'PeerId'>;

export const TaskId = (value: string): TaskId => value as TaskId;
export const AttemptId = (value: string): AttemptId => value as AttemptId;
export const TraceId = (value: string): TraceId => value as TraceId;
export const EventId = (value: string): EventId => value as EventId;
export const PeerId = (value: string): PeerId => value as PeerId;

/** Source of identifiers. Injected so tests and replays are deterministic. */
export interface IdGenerator {
  taskId(): TaskId;
  attemptId(): AttemptId;
  eventId(): EventId;
  /** W3C trace-context compatible: 32 lowercase hex characters, not all zero. */
  traceId(): TraceId;
  /** W3C trace-context compatible span id: 16 lowercase hex characters. */
  spanId(): string;
}

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp followed by random bits.
 * Time-ordered ids keep SQLite primary-key inserts append-mostly.
 */
export function uuidv7(nowMs: number, random: Uint8Array = randomBytes(10)): string {
  if (random.length < 10) throw new RangeError('uuidv7 needs 10 random bytes');
  const bytes = new Uint8Array(16);
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

export function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Production id source: prefixed UUIDv7 for entities, random hex for trace context. */
export class RandomIdGenerator implements IdGenerator {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  taskId(): TaskId {
    return TaskId(`tsk_${uuidv7(this.#clock.now())}`);
  }

  attemptId(): AttemptId {
    return AttemptId(`att_${uuidv7(this.#clock.now())}`);
  }

  eventId(): EventId {
    return EventId(`evt_${uuidv7(this.#clock.now())}`);
  }

  traceId(): TraceId {
    return TraceId(nonZeroHex(16));
  }

  spanId(): string {
    return nonZeroHex(8);
  }
}

function nonZeroHex(byteLength: number): string {
  for (;;) {
    const hex = randomBytes(byteLength).toString('hex');
    if (!/^0+$/.test(hex)) return hex;
  }
}
