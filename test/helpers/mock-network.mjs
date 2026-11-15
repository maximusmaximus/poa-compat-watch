// A local stand-in for a PoA node's public read surface. Used by tests and for dry runs.
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function startMock({ bundle, engine, params, chainId = 'poa-mainnet-1', release = 'vTEST', busyFirst = 0, clientStatus = 200, K = 5, extraFacts = {} } = {}) {
  const bytes = bundle ? (Buffer.isBuffer(bundle) ? bundle : Buffer.from(bundle)) : Buffer.from('export function canonical(o){return JSON.stringify(o)}\n');
  const clientSha = createHash('sha256').update(bytes).digest('hex');
  engine = engine || clientSha;
  params = params || 'b'.repeat(64);
  let busy = busyFirst;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (busy > 0) { busy--; return json(503, { error: 'origin busy', retry_after_seconds: 0 }); }
    const u = req.url.replace(`/chain/${chainId}`, '');
    if (u === '/api/network-facts') return json(200, { chain_id: chainId, open_epoch: 7, engine_sha256: engine, params_sha256: params, economics: { K }, ...extraFacts });
    if (u === '/api/status') return json(200, { chain_id: chainId, K, epochs_closed: 7, checkpoint: { height: 100, cutoff_ts: 1 } });
    if (u === '/api/release') return json(200, { current: { version: release, engine_sha256: engine, params_sha256: params, client_sha256: clientSha, ts: 2 }, history: [{ version: 'vOLD', engine_sha256: 'a'.repeat(64), params_sha256: params, client_sha256: 'a'.repeat(64), ts: 1 }, { version: release, engine_sha256: engine, params_sha256: params, client_sha256: clientSha, ts: 2 }] });
    if (u === '/client/poa.mjs') { if (clientStatus !== 200) return json(clientStatus, {}); res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bytes); }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://127.0.0.1:${port}`, engine, params, clientSha, hits, close: () => new Promise((r) => server.close(r)) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
  const m = await startMock({ bundle: args.bundle ? fs.readFileSync(args.bundle) : undefined, params: args.params, engine: args.engine });
  console.log(JSON.stringify({ origin: m.origin, engine: m.engine, params: m.params }));
}
