#!/usr/bin/env node
// Secret scan (design §15: "禁止在测试 fixture 中放置真实密钥"). Scans tracked-looking source,
// config and docs for credential patterns. Test fixtures deliberately contain *fake* keys
// to exercise redaction; those are recognisable by construction (repeated characters or
// obviously synthetic words) and are allowed only under test/ directories.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.data', '.scratch', 'results']);
const EXT = /\.(ts|mjs|js|json|ya?ml|md|env|txt|sh)$/;

const RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['API key', /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}/],
];

/** Synthetic fixtures: long runs of one character, or explicit test words. */
function synthetic(value) {
  return /(.)\1{7,}/.test(value) || /(TEST|FAKE|EXAMPLE|MUSTNEVER|ABCDEFGHIJ)/i.test(value);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : EXT.test(entry) ? [path] : [];
  });
}

const findings = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (rel === 'package-lock.json' || rel === 'scripts/check-secrets.mjs') continue;
  const isTest = /(^|\/)test\//.test(rel) || rel.startsWith('packages/testkit/');
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [name, re] of RULES) {
        const match = re.exec(line);
        if (match === null) continue;
        if (isTest && synthetic(match[0] + line)) continue;
        if (rel.startsWith('packages/evidence/src/') || rel.startsWith('docs/')) continue; // pattern definitions & prose
        findings.push(`${rel}:${i + 1}: possible ${name}`);
      }
    });
}

if (findings.length > 0) {
  console.error(`secret scan failed:\n${findings.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('secret scan passed');
