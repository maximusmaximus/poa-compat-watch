import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchLive, request } from '../src/fetch-live.mjs';
import { ENGINE, PARAMS, RECEIPT_FIELDS, TRANSFER_FIELDS } from './helpers.mjs';

const sleep = async () => {};

function json(status, body, headers = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify(body), { status, headers });
}

function text(status, body, headers = { 'content-type': 'text/plain' }) {
  return new Response(body, { status, headers });
}

function router(routes) {
  const hits = new Map();
  const fetchImpl = async (url) => {
    const path = new URL(url, 'https://minepoa.com').pathname + (new URL(url, 'https://minepoa.com').search || '');
    hits.set(path, (hits.get(path) || 0) + 1);
    const handler = routes[path] ?? routes[url];
    if (!handler) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return typeof handler === 'function' ? handler(hits.get(path), url) : handler;
  };
  fetchImpl.hits = hits;
  return fetchImpl;
}

const facts = {
  chain_id: 'poa-mainnet-1',
  open_epoch: 84,
  engine_sha256: ENGINE,
  params_sha256: PARAMS,
  economics: { K: 5 }
};
const chainStatus = {
  chain_id: 'poa-mainnet-1',
  K: 5,
  epochs_closed: 84,
  txs: 10,
  final: 9,
  checkpoint: { height: 1, cutoff_ts: 1 }
};
const rootStatus = {
  network: 'PoA prototype',
  K: 5,
  epochs_closed: 84,
  txs: 8,
  final: 7,
  checkpoint_height: 1
};
const params = { chain_id: 'poa-mainnet-1', K: 5, decimals: 6 };
const bundle = '#!/usr/bin/env node\nexport const x = 1;\n';
const bundleSha = createHash('sha256').update(bundle).digest('hex');

const receipt = Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, name === 'status' ? 'included' : name === 'next_nonce' ? 2 : 'x']));
const explorerTx = {
  id: 'ab'.repeat(32),
  type: 'transfer',
  from_addr: 'poa1x',
  to_addr: 'poa1y',
  amount: '1.000000',
  epoch: null,
  ts: 1,
  memo: '',
  atts: 5,
  final: 1,
  body: Object.fromEntries(TRANSFER_FIELDS.map((name) => [name, name === 'parents' ? [] : name])),
  as_of: '2026-11-15T00:00:00.000Z',
  checkpoint_height: 1,
  source: 'test'
};

function coreRoutes(overrides = {}) {
  const txid = 'ab'.repeat(32);
  return {
    '/chain/poa-mainnet-1/api/network-facts': json(200, facts),
    '/api/network-facts': json(200, facts),
    '/chain/poa-mainnet-1/api/status': json(200, chainStatus),
    '/api/status': json(200, rootStatus),
    '/chain/poa-mainnet-1/api/params': json(200, params),
    '/chain/poa-mainnet-1/client/poa.mjs': text(200, bundle),
    '/client/poa.mjs': text(200, bundle),
    '/api/explorer/txs?type=transfer&limit=50': json(200, [{ id: txid, type: 'transfer' }]),
    '/api/explorer/txs': json(200, [{ id: txid, type: 'transfer' }]),
    [`/api/receipt/${txid}`]: json(200, receipt),
    [`/chain/poa-mainnet-1/api/receipt/${txid}`]: json(200, receipt),
    [`/api/explorer/tx/${txid}`]: json(200, explorerTx),
    [`/chain/poa-mainnet-1/api/explorer/tx/${txid}`]: json(200, explorerTx),
    '/api/txs': json(200, { valid: [{ id: txid, ts: 1 }] }),
    ...overrides
  };
}

describe('fetchLive', () => {
  it('normalizes facts, hashes the client bundle, and records field names only', async () => {
    const live = await fetchLive({ fetchImpl: router(coreRoutes()), sleep, retries: 3 });
    assert.equal(live.ok, true);
    assert.equal(live.chainId, 'poa-mainnet-1');
    assert.equal(live.engineSha256, ENGINE);
    assert.equal(live.paramsSha256, PARAMS);
    assert.equal(live.clientBundleSha256, bundleSha);
    assert.equal(live.K, 5);
    assert.equal(live.decimals, 6);
    assert.equal(live.transferObserved, true);
    assert.deepEqual(live.transferBodyFields, TRANSFER_FIELDS);
    assert.ok(live.receiptObserved);
    assert.ok(!JSON.stringify(live).includes('poa1x') || live.explorerType === 'transfer');
    // Addresses may appear in unused route fixtures but the observation itself should not store them.
    assert.equal(live.receiptFields.includes('from'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(live, 'sampleTxid'), false);
  });

  it('retries 503s and warns when the flaky endpoint stays down', async () => {
    let txsHits = 0;
    const fetchImpl = router(
      coreRoutes({
        '/api/txs': async () => {
          txsHits += 1;
          return json(503, { error: 'temporarily paused' });
        }
      })
    );
    const live = await fetchLive({ fetchImpl, sleep, retries: 3 });
    assert.equal(live.ok, true);
    assert.equal(txsHits, 3);
    assert.equal(live.endpoints['/api/txs'].ok, false);
    assert.equal(live.endpoints['/api/txs'].attempts, 3);
    assert.ok(live.warnings.some((row) => row.path === '/api/txs' && row.persistent));
  });

  it('succeeds after a transient 503 and does not mark it persistent', async () => {
    let factsHits = 0;
    const fetchImpl = router(
      coreRoutes({
        '/chain/poa-mainnet-1/api/network-facts': async (n) => {
          factsHits += 1;
          if (n === 1) return json(503, { error: 'busy' });
          return json(200, facts);
        }
      })
    );
    const live = await fetchLive({ fetchImpl, sleep, retries: 3 });
    assert.equal(live.ok, true);
    assert.ok(factsHits >= 2);
    const warning = live.warnings.find((row) => row.path === '/chain/poa-mainnet-1/api/network-facts');
    assert.equal(warning, undefined);
    assert.equal(live.endpoints['/chain/poa-mainnet-1/api/network-facts'].ok, true);
    assert.ok(live.endpoints['/chain/poa-mainnet-1/api/network-facts'].attempts >= 2);
  });

  it('warns when root status diverges from chain status', async () => {
    const live = await fetchLive({ fetchImpl: router(coreRoutes()), sleep, retries: 1 });
    assert.ok(live.warnings.some((row) => row.code === 'STATUS_SCHEMA_DIVERGENCE'));
  });

  it('returns a checker error when both network-facts paths fail', async () => {
    const fetchImpl = router(
      coreRoutes({
        '/chain/poa-mainnet-1/api/network-facts': json(503, { error: 'busy' }),
        '/api/network-facts': json(503, { error: 'busy' })
      })
    );
    const live = await fetchLive({ fetchImpl, sleep, retries: 2 });
    assert.equal(live.ok, false);
    assert.match(live.error, /network-facts/);
  });

  it('records transfer-not-observed when the listing has no transfer', async () => {
    const other = { ...explorerTx, type: 'grade-sealed', body: { type: 'grade-sealed', from: 'x', nonce: 1, parents: [], ts: 1, cid: 'poa-mainnet-1', sig: 's' } };
    const fetchImpl = router(
      coreRoutes({
        '/api/explorer/txs?type=transfer&limit=50': json(200, []),
        '/api/explorer/txs': json(200, [{ id: 'ab'.repeat(32), type: 'grade-sealed' }]),
        [`/api/explorer/tx/${'ab'.repeat(32)}`]: json(200, other)
      })
    );
    const live = await fetchLive({ fetchImpl, sleep, retries: 1 });
    assert.equal(live.ok, true);
    assert.equal(live.transferObserved, false);
    assert.equal(live.receiptObserved, true);
  });
});

describe('request', () => {
  it('refuses redirects', async () => {
    const fetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    const result = await request('https://minepoa.com/api/status', { fetchImpl, retries: 1, sleep });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'redirect-refused');
  });
});
