// Fixture client bundle, version 3: wire-format and API breaks.
import crypto from 'node:crypto';
export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PROTOCOL_VERSION = 4;
export function canonical(obj, opts) {
  if (Array.isArray(obj)) return '[' + obj.map(o => canonical(o, opts)).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + '=' + canonical(obj[k], opts)).join(',') + '}';
  return JSON.stringify(obj);
}
export const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
export function txidOf(body) {
  const { sig, ...rest } = body;
  return sha256hex(canonical(rest));
}
export function buildTx(ledger, signer, fields) {
  const body = { ...fields, from: signer.address, seq: 1, parents: [], ts: 0 };
  return body;
}
export function replay(ledger) {
  for (const t of ledger.txs) {
    if (t.body.type === 'send') ledger.balances[t.body.to] = t.body.amount;
  }
  return ledger.checkpoint.height;
}
