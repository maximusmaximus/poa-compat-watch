#!/usr/bin/env node
// Scan every tracked (or staged) file for credential-shaped strings. Exit 1 on any hit.
import { execFileSync } from 'node:child_process';
import { scanFiles } from '../src/secret-scan.mjs';

const staged = process.argv.includes('--staged');
const list = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('test/fixtures/') || !f.endsWith('.bin'));
const hits = scanFiles(process.cwd(), list);
for (const h of hits) console.error(`possible secret: ${h.file}:${h.line}`);
console.log(`secret scan: ${list.length} files, ${hits.length} finding(s)`);
process.exit(hits.length ? 1 : 0);
