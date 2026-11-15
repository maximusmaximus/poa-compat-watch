import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractSurface, normalizeParams, maskSource } from '../src/surface.mjs';
import { compareSurfaces, checkExpectations } from '../src/compare.mjs';

const read = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const v1 = extractSurface(read('bundle-v1.mjs'));
const v2 = extractSurface(read('bundle-v2-compatible.mjs'));
const v3 = extractSurface(read('bundle-v3-breaking.mjs'));
const uses = {
  exports: ['canonical', 'txidOf', 'buildTx', 'sha256hex'],
  critical: ['canonical', 'txidOf'],
  txTypes: ['transfer'],
  fields: { body: ['type', 'from', 'to', 'amount', 'memo', 'nonce'] },
  constants: ['B58', 'PROTOCOL_VERSION'],
};

test('extracts exports, signatures, constants, tx types and shapes', () => {
  assert.deepEqual(Object.keys(v1.exports).sort(), ['B58', 'buildTx', 'canonical', 'legacyHelper', 'replay', 'sha256hex', 'txidOf']);
  assert.equal(v1.exports.buildTx.params, 'ledger,wallet,fields');
  assert.equal(v1.exports.sha256hex.kind, 'function');
  assert.equal(v1.exports.sha256hex.params, 's');
  assert.equal(v1.constants.PROTOCOL_VERSION, '3');
  assert.equal(v1.constants.B58.length, 58);
  assert.deepEqual(v1.txTypes, ['notice', 'transfer']);
  for (const f of ['type', 'from', 'to', 'amount', 'memo', 'nonce', 'parents', 'ts']) assert.ok(v1.shapes.body.includes(f), f);
  assert.ok(v1.shapes.checkpoint.includes('height'));
});

test('comments do not change code fingerprints; code does', () => {
  assert.equal(v1.functions.txidOf.bodyHash, v2.functions.txidOf.bodyHash);
  assert.equal(v1.functions.canonical.bodyHash, v2.functions.canonical.bodyHash);
  assert.notEqual(v1.functions.canonical.bodyHash, v3.functions.canonical.bodyHash);
});

test('normalizeParams drops defaults and whitespace', () => {
  assert.equal(normalizeParams('a, b = 1, { c, d = 2 } = {}, ...rest'), 'a,b,{c,d},...rest');
  assert.equal(normalizeParams(''), '');
});

test('maskSource hides strings, comments and regex bodies but keeps offsets', () => {
  const src = "const a = '//x'; // c\nconst r = /a\\/b/g; const t = `x${1}y`;";
  const m = maskSource(src);
  assert.equal(m.length, src.length);
  assert.ok(!m.includes('//x'));
  assert.ok(!m.includes('// c'));
});

test('additive release is not breaking', () => {
  const d = compareSurfaces(v1, v2, uses);
  assert.equal(d.breaking, false);
  assert.ok(d.changes.some((c) => c.kind === 'export-added' && c.name === 'newHelper'));
  assert.ok(d.changes.some((c) => c.kind === 'txtype-added' && c.name === 'stake'));
  const sig = d.changes.find((c) => c.kind === 'signature' && c.name === 'buildTx');
  assert.equal(sig.severity, 'review');
});

test('wire and API breaks are breaking', () => {
  const d = compareSurfaces(v1, v3, uses);
  assert.equal(d.breaking, true);
  const kinds = d.changes.filter((c) => c.severity === 'breaking').map((c) => `${c.kind}:${c.name}`);
  for (const k of ['critical-changed:canonical', 'signature:buildTx', 'txtype-removed:transfer', 'field-removed:body.nonce', 'constant:PROTOCOL_VERSION'])
    assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  // legacyHelper is not used by this project: informational only.
  assert.equal(d.changes.find((c) => c.name === 'legacyHelper').severity, 'info');
});

test('without a uses list every removal counts', () => {
  const d = compareSurfaces(v1, v3, {});
  assert.equal(d.changes.find((c) => c.name === 'legacyHelper').severity, 'breaking');
});

test('checkExpectations', () => {
  const facts = { chain_id: 'x', economics: { K: 5 } };
  assert.deepEqual(checkExpectations(facts, { chain_id: 'x', 'economics.K': 5, chain_id2: 'present' }), ['`chain_id2` is missing']);
  assert.equal(checkExpectations(facts, { 'economics.K': 7 }).length, 1);
});
