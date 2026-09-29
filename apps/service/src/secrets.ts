import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { HarnessError, SecretValue, type SecretProvider } from '@dvo/core';

/**
 * Resolves `secret://a/b/c` references (design §9.4: credentials are injected, never written
 * into tasks, traces or errors). Lookup order:
 *   1. environment variable `<prefix>A_B_C` (upper-cased, non-alphanumerics → `_`);
 *   2. file `<dir>/a/b/c` (e.g. a Docker/Kubernetes secrets mount), trailing newline trimmed.
 * Values are wrapped in SecretValue so they cannot be logged by accident.
 */
export class EnvFileSecretProvider implements SecretProvider {
  readonly #prefix: string;
  readonly #dir: string | undefined;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: { envPrefix?: string; dir?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#prefix = options.envPrefix ?? 'HARNESS_SECRET_';
    this.#dir = options.dir;
    this.#env = options.env ?? process.env;
  }

  async resolve(ref: string): Promise<SecretValue> {
    const match = /^secret:\/\/([a-z0-9][a-z0-9/_.-]*)$/i.exec(ref);
    if (match === null) throw new HarnessError('validation_failed', 'malformed secret reference');
    const path = match[1]!;
    if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
      throw new HarnessError('validation_failed', 'secret reference must not traverse directories');
    }
    const envName = `${this.#prefix}${path.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    const fromEnv = this.#env[envName];
    if (fromEnv !== undefined && fromEnv !== '') return new SecretValue(fromEnv);
    if (this.#dir !== undefined) {
      const file = normalize(join(this.#dir, path));
      if (!file.startsWith(normalize(this.#dir) + sep))
        throw new HarnessError('validation_failed', 'secret reference escapes the secrets directory');
      try {
        const value = (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
        if (value !== '') return new SecretValue(value);
      } catch {
        // fall through to the not-found error below
      }
    }
    // The reference itself is not sensitive, but keep even that out of the message.
    throw new HarnessError('not_found', 'secret could not be resolved', { details: { envName } });
  }
}
