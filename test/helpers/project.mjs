import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poa-compat-test-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  return root;
}
