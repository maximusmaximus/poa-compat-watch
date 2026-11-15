// Minimal pre-push secret scan. Meant as a last guard, not a replacement for a full scanner.
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_PATTERNS } from './redact.mjs';

const EXTRA = [
  /\b(?:token|secret|password|api[_-]?key|private[_-]?key|privkey)\s*[:=]\s*["'][A-Za-z0-9+/_\-]{20,}["']/i,
];

export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const re of [...SECRET_PATTERNS, ...EXTRA]) {
      const r = new RegExp(re.source, re.flags.replace('g', ''));
      if (r.test(line)) { hits.push({ line: i + 1, pattern: re.source.slice(0, 40) }); break; }
    }
  });
  return hits;
}

export function scanFiles(root, files) {
  const hits = [];
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const h of scanText(text)) hits.push({ file: f, ...h });
  }
  return hits;
}
