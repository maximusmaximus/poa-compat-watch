// Fixture client bundle, version 2: additive changes only, internals reworded.
import crypto from 'node:crypto';
export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PROTOCOL_VERSION = 3;
export function canonical(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  return JSON.stringify(obj); // "strings // are not comments"
}
export const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
export function txidOf(body) {
  // a new comment does not change the code fingerprint
  const { sig, ...rest } = body;
  return sha256hex(canonical(rest));
}
export function buildTx(ledger, wallet, fields, opts = {}) {
  const body = { ...fields, from: wallet.address, nonce: 1, parents: [], ts: opts.ts ?? 0 };
  if (body.type === 'transfer' && body.amount) body.memo = body.memo || '';
  return body;
}
export function replay(ledger) {
  for (const t of ledger.txs) {
    if (t.body.type === 'transfer') ledger.balances[t.body.to] = t.body.amount;
    else if (t.body.type === 'notice') ledger.notices.push(t.body.text);
    else if (t.body.type === 'stake') ledger.stakes.push(t.body.amount);
  }
  return ledger.checkpoint.height;
}
export function legacyHelper(a, b) { return a + b; }
export function newHelper() { return 1; }
