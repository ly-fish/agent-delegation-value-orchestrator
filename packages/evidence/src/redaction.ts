export interface RedactionRule {
  id: string;
  pattern: RegExp;
  /** Replacement template; defaults to `[REDACTED:<id>]`. May reference capture groups. */
  replacement?: string;
}

/**
 * Credential patterns scrubbed from every string that is persisted, logged or sent to a
 * peer (invariant 6). Ordered from most to least specific.
 */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  { id: 'private_key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'auth_header', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { id: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'api_key', pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'url_credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replacement: '$1[REDACTED]@' },
  {
    id: 'secret_assignment',
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret)\b(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
    replacement: '$1$2[REDACTED]',
  },
];

const DEFAULT_SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|x-api-key|private[-_]?key|credentials?)$/i;

const EMAIL_RULE: RedactionRule = { id: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g };

export interface RedactorOptions {
  rules?: readonly RedactionRule[];
  extraRules?: readonly RedactionRule[];
  sensitiveKey?: RegExp;
  redactEmails?: boolean;
  /** Maximum object depth walked; deeper values are replaced wholesale. */
  maxDepth?: number;
}

export interface RedactionResult<T> {
  value: T;
  hits: number;
  byRule: Record<string, number>;
}

export class Redactor {
  readonly #rules: readonly RedactionRule[];
  readonly #sensitiveKey: RegExp;
  readonly #maxDepth: number;

  constructor(options: RedactorOptions = {}) {
    this.#rules = [
      ...(options.rules ?? DEFAULT_REDACTION_RULES),
      ...(options.extraRules ?? []),
      ...(options.redactEmails ? [EMAIL_RULE] : []),
    ];
    this.#sensitiveKey = options.sensitiveKey ?? DEFAULT_SENSITIVE_KEY;
    this.#maxDepth = options.maxDepth ?? 32;
  }

  redactText(text: string): RedactionResult<string> {
    const byRule: Record<string, number> = {};
    let hits = 0;
    let out = text;
    for (const rule of this.#rules) {
      const replacement = rule.replacement ?? `[REDACTED:${rule.id}]`;
      out = out.replace(rule.pattern, (...args: unknown[]) => {
        hits += 1;
        byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
        // Expand $1..$9 against this match's capture groups.
        const groups = args.slice(1, -2) as Array<string | undefined>;
        return replacement.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '');
      });
    }
    return { value: out, hits, byRule };
  }

  /**
   * Deep-redacts strings and replaces values under sensitive keys. Never mutates the input.
   * Only plain objects and arrays are walked: class instances (sockets, requests, errors,
   * buffers) are returned untouched for their own serialisers, and cycles are cut, so an
   * arbitrary object graph handed to a logger can never blow up.
   */
  redact<T>(value: T): RedactionResult<T> {
    const byRule: Record<string, number> = {};
    let hits = 0;
    const count = (id: string): void => {
      hits += 1;
      byRule[id] = (byRule[id] ?? 0) + 1;
    };
    // Ancestors on the current path: a repeated reference is only a cycle if it is its own ancestor
    // (shared, acyclic references — e.g. a decision's selected action — must be copied, not cut).
    const path = new Set<object>();
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === 'string') {
        const r = this.redactText(v);
        for (const [id, n] of Object.entries(r.byRule)) for (let i = 0; i < n; i++) count(id);
        return r.value;
      }
      if (v === null || typeof v !== 'object') return v;
      if (!Array.isArray(v) && !isPlainObject(v)) return v;
      if (path.has(v)) return '[Circular]';
      if (depth >= this.#maxDepth) {
        count('max_depth');
        return '[REDACTED:max_depth]';
      }
      path.add(v);
      try {
        if (Array.isArray(v)) return v.map((item: unknown) => walk(item, depth + 1));
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
          if (this.#sensitiveKey.test(key) && inner !== undefined && inner !== null && inner !== '') {
            count('sensitive_key');
            out[key] = '[REDACTED]';
          } else {
            out[key] = walk(inner, depth + 1);
          }
        }
        return out;
      } finally {
        path.delete(v);
      }
    };
    return { value: walk(value, 0) as T, hits, byRule };
  }

  /** True when `text` contains anything a rule would redact. */
  containsSecret(text: string): boolean {
    return this.redactText(text).hits > 0;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
