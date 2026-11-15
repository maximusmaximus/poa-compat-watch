export const ENGINE = '92658c61bc75d24572b8eef6182af27436a4f00019854718dcf0de3c6d2b54f6';
export const PARAMS = 'bc823648e0efa9343e62b153a61d74180a32dca8581f1856376616c1e8e0a15f';

export const RECEIPT_FIELDS = [
  'txid',
  'status',
  'from',
  'type',
  'valid_in_open_window',
  'checkpoint_covered',
  'source',
  'note',
  'next_nonce'
];

export const EXPLORER_FIELDS = [
  'id',
  'type',
  'from_addr',
  'to_addr',
  'amount',
  'epoch',
  'ts',
  'memo',
  'atts',
  'final',
  'body',
  'as_of',
  'checkpoint_height',
  'source'
];

export const TRANSFER_FIELDS = ['type', 'from', 'to', 'amount', 'memo', 'nonce', 'parents', 'ts', 'cid', 'sig'];

export function okEndpoint() {
  return { ok: true, status: 200, attempts: 1 };
}

export function failEndpoint(status = 503, attempts = 3) {
  return { ok: false, status, attempts, error: undefined };
}

export function compatibleLive(overrides = {}) {
  const endpoints = {
    '/chain/poa-mainnet-1/api/network-facts': okEndpoint(),
    '/api/network-facts': okEndpoint(),
    '/chain/poa-mainnet-1/api/status': okEndpoint(),
    '/api/status': okEndpoint(),
    '/chain/poa-mainnet-1/api/params': okEndpoint(),
    '/chain/poa-mainnet-1/client/poa.mjs': okEndpoint(),
    '/client/poa.mjs': okEndpoint(),
    '/api/explorer/txs': okEndpoint(),
    '/api/explorer/tx/:id': okEndpoint(),
    '/chain/poa-mainnet-1/api/explorer/tx/:id': okEndpoint(),
    '/api/receipt/:id': okEndpoint(),
    '/chain/poa-mainnet-1/api/receipt/:id': okEndpoint(),
    '/api/txs': okEndpoint(),
    ...(overrides.endpoints || {})
  };
  return {
    ok: true,
    error: null,
    source: 'https://minepoa.com',
    chainId: 'poa-mainnet-1',
    engineSha256: ENGINE,
    paramsSha256: PARAMS,
    clientBundleSha256: ENGINE,
    clientBundleUrls: ['/chain/poa-mainnet-1/client/poa.mjs', '/client/poa.mjs'],
    K: 5,
    decimals: 6,
    receiptFields: [...RECEIPT_FIELDS],
    receiptObserved: true,
    explorerTxFields: [...EXPLORER_FIELDS],
    explorerBodyFields: [...TRANSFER_FIELDS],
    explorerType: 'transfer',
    explorerObserved: true,
    transferBodyFields: [...TRANSFER_FIELDS],
    transferObserved: true,
    endpoints,
    warnings: [],
    status: {
      chainId: 'poa-mainnet-1',
      K: 5,
      epochsClosed: 84,
      txs: 4000,
      final: 3990,
      checkpointHeight: 988190
    },
    ...overrides,
    endpoints
  };
}

export { compatibleLive as liveFixture };
