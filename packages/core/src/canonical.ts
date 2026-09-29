import { createHash } from 'node:crypto';
import { formatUuid } from './ids.ts';

/**
 * Deterministic JSON serialisation: object keys sorted, `undefined` members dropped,
 * non-finite numbers rejected. Used for request digests, card digests and observation
 * de-duplication, so two logically equal payloads always hash identically.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, new Set());
}

function serialise(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object': {
      if (seen.has(value)) throw new TypeError('canonicalJson: cyclic structure');
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item: unknown) => (item === undefined ? 'null' : serialise(item, seen))).join(',')}]`;
        }
        if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && typeof v !== 'function')
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v, seen)}`).join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 over the canonical JSON form. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Namespace for name-based UUIDs derived from this project's idempotency keys. */
export const DVO_UUID_NAMESPACE = '6f1d2c5e-8a4b-5c3d-9e7f-0a1b2c3d4e5f';

/**
 * RFC 9562 UUIDv5 (SHA-1, name-based). The A2A bridge derives the wire `messageId`
 * from the application idempotency key with this, so a resubmission after a crash is
 * byte-identical and a de-duplicating peer can recognise it.
 */
export function uuidv5(name: string, namespace: string = DVO_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  if (ns.length !== 16) throw new RangeError('uuidv5: namespace must be a UUID');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = new Uint8Array(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}
