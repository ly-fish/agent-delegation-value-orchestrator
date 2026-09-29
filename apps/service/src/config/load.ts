import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '@dvo/core';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  PeersFileSchema,
  type PeerFileEntry,
  PolicyFileSchema,
  type PolicyFile,
  RuntimeLockFileSchema,
  type RuntimeLockFile,
  ServiceFileSchema,
  type ServiceFile,
} from './schema.ts';

export interface LoadedConfig {
  dir: string;
  service: ServiceFile;
  peers: PeerFileEntry[];
  policy: PolicyFile;
  lock: RuntimeLockFile;
}

/**
 * Loads the four configuration files from `dir`. For each, `<name>.yaml` wins over
 * `<name>.example.yaml`, so the repository's examples run out of the box and a deployment
 * overrides them by dropping real files next to them. Relative paths inside the files are
 * resolved against the configuration directory.
 */
export function loadConfig(dir: string): LoadedConfig {
  const root = resolve(dir);
  const service = readYaml(root, 'service', ServiceFileSchema);
  const peers = readYaml(root, 'peers', PeersFileSchema);
  const policy = readYaml(root, 'policy', PolicyFileSchema);
  const lock = readYaml(root, 'runtime-lock', RuntimeLockFileSchema);
  const ids = new Set<string>();
  for (const peer of peers.peers) {
    if (ids.has(peer.id)) throw new ValidationError(`duplicate peer id ${peer.id}`);
    ids.add(peer.id);
  }
  const at = (p: string): string => (isAbsolute(p) ? p : join(root, p));
  const envPort = process.env['HARNESS_HTTP_PORT'];
  const envHost = process.env['HARNESS_HTTP_HOST'];
  if (envPort !== undefined && !/^\d{1,5}$/.test(envPort)) throw new ValidationError('HARNESS_HTTP_PORT must be a port number');
  return {
    dir: root,
    service: {
      ...service,
      http: {
        ...service.http,
        ...(envPort === undefined ? {} : { port: Number(envPort) }),
        ...(envHost === undefined ? {} : { host: envHost }),
      },
      storage: {
        sqlitePath: service.storage.sqlitePath === ':memory:' ? ':memory:' : at(service.storage.sqlitePath),
        quarantineDir: at(service.storage.quarantineDir),
      },
      secrets: { ...service.secrets, ...(service.secrets.dir === undefined ? {} : { dir: at(service.secrets.dir) }) },
    },
    peers: peers.peers,
    policy,
    lock: {
      ...lock,
      dsh: {
        ...lock.dsh,
        patchFiles: lock.dsh.patchFiles.map(at),
        workdir: at(lock.dsh.workdir),
        command: lock.dsh.command.map((c, i) => (i > 0 && (c.startsWith('./') || c.startsWith('../')) ? at(c) : c)),
      },
    },
  };
}

function readYaml<S extends z.ZodType>(root: string, name: string, schema: S): z.infer<S> {
  const real = join(root, `${name}.yaml`);
  const example = join(root, `${name}.example.yaml`);
  const path = existsSync(real) ? real : existsSync(example) ? example : undefined;
  if (path === undefined) throw new ValidationError(`missing configuration file ${name}.yaml in ${root}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8')) ?? {};
  } catch (error) {
    throw new ValidationError(`${path} is not valid YAML`, [String(error)]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `invalid configuration in ${path}`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** Default configuration directory: $HARNESS_CONFIG_DIR, else ./configs next to the repo root. */
export function defaultConfigDir(): string {
  return process.env['HARNESS_CONFIG_DIR'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../configs');
}
