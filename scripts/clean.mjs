#!/usr/bin/env node
// Removes build outputs (dist/, coverage/) across the workspace.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const targets = ['coverage'];
for (const group of ['packages', 'apps', 'examples']) {
  for (const name of readdirSync(join(ROOT, group))) targets.push(join(group, name, 'dist'));
}
for (const target of targets) rmSync(join(ROOT, target), { recursive: true, force: true });
console.log(`removed ${targets.length} build output locations`);
