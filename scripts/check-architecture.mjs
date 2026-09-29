#!/usr/bin/env node
// Architecture fitness function (design §13): dependency direction is one-way and
// infrastructure only enters through ports. Checks every import in every package's src/
// (tests are exempt) against the allowed edges below, plus boundary rules:
//   - only @dvo/dsh-bridge may reference DeepSeek Harness;
//   - only @dvo/a2a-bridge may reference A2A wire SDKs;
//   - only @dvo/trace may open SQLite;
//   - @dvo/core has no dependencies at all (Node built-ins only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const ALLOWED = {
  core: [],
  evidence: ['core'],
  scheduler: ['core'],
  policy: ['core'],
  trace: ['core'],
  verifier: ['core', 'evidence'],
  'dsh-bridge': ['core', 'evidence'],
  'a2a-bridge': ['core', 'evidence', 'scheduler'],
  orchestrator: ['core', 'evidence', 'policy', 'scheduler', 'trace', 'verifier'],
  testkit: ['core'],
  service: ['core', 'evidence', 'scheduler', 'policy', 'trace', 'verifier', 'dsh-bridge', 'a2a-bridge', 'orchestrator'],
};

const THIRD_PARTY = {
  core: [],
  evidence: ['zod'],
  scheduler: [],
  policy: [],
  trace: [],
  verifier: [],
  'dsh-bridge': [],
  'a2a-bridge': ['zod'],
  orchestrator: [],
  testkit: [],
  service: ['fastify', 'pino', 'yaml', 'zod'],
};

const BOUNDARIES = [
  { pattern: /@deepseek-ai\//, owner: 'dsh-bridge', what: 'DeepSeek Harness' },
  { pattern: /@a2a-js\//, owner: 'a2a-bridge', what: 'A2A SDK' },
  { pattern: /^node:sqlite$/, owner: 'trace', what: 'SQLite' },
];

const units = [
  ...readdirSync(join(ROOT, 'packages')).map((name) => ({ name, dir: join(ROOT, 'packages', name, 'src') })),
  { name: 'service', dir: join(ROOT, 'apps', 'service', 'src') },
];

const violations = [];
const importRe = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

for (const unit of units) {
  if (!(unit.name in ALLOWED)) {
    violations.push(`${unit.name}: package has no entry in the architecture map`);
    continue;
  }
  for (const file of files(unit.dir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importRe)) {
      const spec = match[1] ?? match[2];
      const where = `${relative(ROOT, file)}: ${spec}`;
      if (spec.startsWith('.') || (spec.startsWith('node:') && spec !== 'node:sqlite')) continue;
      for (const b of BOUNDARIES) {
        if (b.pattern.test(spec) && unit.name !== b.owner) violations.push(`${where} — only ${b.owner} may use ${b.what}`);
      }
      if (spec === 'node:sqlite') continue;
      if (spec.startsWith('@dvo/')) {
        const target = spec.slice('@dvo/'.length).split('/')[0];
        if (target !== unit.name && !ALLOWED[unit.name].includes(target))
          violations.push(`${where} — ${unit.name} must not depend on ${target}`);
        continue;
      }
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!THIRD_PARTY[unit.name].includes(pkg)) violations.push(`${where} — third-party dependency ${pkg} not allowed in ${unit.name}`);
    }
  }
}

// package.json must agree with the map (no undeclared or forbidden workspace edges).
for (const unit of units) {
  const manifest = JSON.parse(readFileSync(join(unit.dir, '..', 'package.json'), 'utf8'));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith('@dvo/')) continue;
    const target = dep.slice('@dvo/'.length);
    if (!ALLOWED[unit.name]?.includes(target)) violations.push(`${unit.name}/package.json declares forbidden dependency ${dep}`);
  }
}

if (violations.length > 0) {
  console.error(`architecture check failed (${violations.length}):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log(`architecture check passed (${units.length} units)`);
