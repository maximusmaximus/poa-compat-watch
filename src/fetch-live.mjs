import { createHash } from 'node:crypto';

export const DEFAULT_SOURCE = 'https://minepoa.com';
export const DEFAULT_CHAIN = 'poa-mainnet-1';
export const DEFAULT_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

const sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function origin(source) {
  return String(source || DEFAULT_SOURCE).replace(/\/+$/, '');
}

function joinUrl(source, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return origin(source) + (path.startsWith('/') ? path : `/${path}`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(buf) {
  const text = Buffer.from(buf).toString('utf8');
  return JSON.parse(text);
}

/**
 * GET with retries on 429/5xx and network/timeout errors.
 * Redirects are refused. The client bundle is hashed, never executed.
 */
export async function request(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep || sleepFn;
  let last = { ok: false, status: 0, url, attempts: 0, error: 'no-attempt' };

  for (let i = 0; i < retries; i++) {
    const attempts = i + 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: ac.signal });
      const status = res.status;
      if (status >= 300 && status < 400) {
        last = { ok: false, status, url, attempts, error: 'redirect-refused' };
        return last;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      last = {
        ok: status >= 200 && status < 300,
        status,
        url,
        attempts,
        bytes,
        sha256: sha256(bytes),
        contentType: res.headers?.get?.('content-type') || ''
      };
      if (last.ok || !RETRY_STATUSES.has(status)) return last;
    } catch (err) {
      const name = err && err.name;
      last = {
        ok: false,
        status: 0,
        url,
        attempts,
        error: name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network'
      };
    } finally {
      clearTimeout(timer);
    }
    if (i < retries - 1) await sleep(400 * 2 ** i);
  }
  return last;
}

function recordEndpoint(endpoints, path, result) {
  endpoints[path] = {
    ok: !!result.ok,
    status: result.status || 0,
    attempts: result.attempts || 0,
    error: result.error || undefined,
    sha256: result.ok ? result.sha256 : undefined
  };
}

function warnUnavailable(warnings, path, result, persistent) {
  warnings.push({
    code: persistent ? 'ENDPOINT_UNAVAILABLE' : 'ENDPOINT_RETRY',
    path,
    status: result.status || 0,
    attempts: result.attempts || 0,
    error: result.error || undefined,
    persistent: !!persistent
  });
}

async function getPath(source, path, endpoints, warnings, options) {
  const result = await request(joinUrl(source, path), options);
  recordEndpoint(endpoints, path, result);
  if (!result.ok) {
    const persistent = !result.ok && (result.attempts || 0) >= (options.retries ?? DEFAULT_RETRIES);
    warnUnavailable(warnings, path, result, persistent);
  }
  return result;
}

async function firstOk(source, paths, endpoints, warnings, options) {
  let last = null;
  for (const path of paths) {
    const result = await getPath(source, path, endpoints, warnings, options);
    last = { path, result };
    if (result.ok) return last;
  }
  return last;
}

function jsonFrom(result) {
  if (!result?.ok || !result.bytes) return null;
  try {
    return parseJson(result.bytes);
  } catch {
    return { __parseError: true };
  }
}

function fieldsOf(value) {
  return isObject(value) ? Object.keys(value) : [];
}

/**
 * Fetch the live network surface. Returns a normalized observation plus warnings.
 * Does not include wallet, memo, or signature values — only hashes, counts, and field names.
 */
export async function fetchLive(options = {}) {
  const source = origin(options.source || DEFAULT_SOURCE);
  const chainId = options.chainId || DEFAULT_CHAIN;
  const warnings = [];
  const endpoints = {};
  const req = { ...options, fetchImpl: options.fetchImpl || globalThis.fetch };

  const factsPaths = [`/chain/${chainId}/api/network-facts`, '/api/network-facts'];
  const statusPaths = [`/chain/${chainId}/api/status`, '/api/status'];
  const paramsPaths = [`/chain/${chainId}/api/params`];
  const clientPaths = [`/chain/${chainId}/client/poa.mjs`, '/client/poa.mjs'];

  const [factsHit, statusHit, paramsHit, primaryClient] = await Promise.all([
    firstOk(source, factsPaths, endpoints, warnings, req),
    firstOk(source, statusPaths, endpoints, warnings, req),
    firstOk(source, paramsPaths, endpoints, warnings, req),
    getPath(source, clientPaths[0], endpoints, warnings, req)
  ]);
  const fallbackClient = primaryClient.ok
    ? await getPath(source, clientPaths[1], endpoints, warnings, req)
    : (await firstOk(source, clientPaths.slice(1), endpoints, warnings, req))?.result;

  const factsJson = jsonFrom(factsHit?.result);
  const statusJson = jsonFrom(statusHit?.result);
  const paramsJson = jsonFrom(paramsHit?.result);

  if (factsHit?.result?.ok && factsJson?.__parseError) {
    return { ok: false, error: 'network-facts response is not valid JSON', source, endpoints, warnings };
  }
  if (!factsHit?.result?.ok || !isObject(factsJson)) {
    return {
      ok: false,
      error: 'unable to read network-facts from the live node after retries',
      source,
      endpoints,
      warnings
    };
  }

  const chainFacts = factsJson;
  const engineSha256 = typeof chainFacts.engine_sha256 === 'string' ? chainFacts.engine_sha256 : null;
  const paramsSha256 = typeof chainFacts.params_sha256 === 'string' ? chainFacts.params_sha256 : null;
  const factsChainId = typeof chainFacts.chain_id === 'string' ? chainFacts.chain_id : null;
  const factsK = Number.isInteger(chainFacts.economics?.K) ? chainFacts.economics.K : null;

  // Re-fetch the other facts path if firstOk stopped early, so we can compare.
  const otherFactsPath = factsPaths.find((p) => p !== factsHit.path);
  if (otherFactsPath && !endpoints[otherFactsPath]) {
    const other = await getPath(source, otherFactsPath, endpoints, warnings, req);
    if (other.ok) {
      const otherJson = jsonFrom(other);
      if (isObject(otherJson) && !otherJson.__parseError) {
        if (otherJson.engine_sha256 !== engineSha256 || otherJson.params_sha256 !== paramsSha256 || otherJson.chain_id !== factsChainId) {
          warnings.push({
            code: 'FACTS_PATH_MISMATCH',
            path: otherFactsPath,
            detail: 'chain and root network-facts disagree'
          });
        }
      }
    }
  }

  const chainStatusPath = `/chain/${chainId}/api/status`;
  const rootStatusPath = '/api/status';
  let chainStatus = statusHit?.path === chainStatusPath ? statusJson : null;
  let rootStatus = statusHit?.path === rootStatusPath ? statusJson : null;
  if (!chainStatus && endpoints[chainStatusPath] == null) {
    const extra = await getPath(source, chainStatusPath, endpoints, warnings, req);
    chainStatus = jsonFrom(extra);
  }
  if (!rootStatus && endpoints[rootStatusPath] == null) {
    const extra = await getPath(source, rootStatusPath, endpoints, warnings, req);
    rootStatus = jsonFrom(extra);
  }
  if (isObject(chainStatus) && !chainStatus.__parseError && isObject(rootStatus) && !rootStatus.__parseError) {
    const sameK = chainStatus.K === rootStatus.K;
    const sameEpoch = chainStatus.epochs_closed === rootStatus.epochs_closed;
    const sameHeight =
      chainStatus.checkpoint?.height === rootStatus.checkpoint_height ||
      chainStatus.checkpoint_height === rootStatus.checkpoint_height;
    const txsDiffer = chainStatus.txs !== rootStatus.txs || chainStatus.final !== rootStatus.final;
    const schemaDiffers = rootStatus.chain_id === undefined || rootStatus.checkpoint === undefined;
    if (!sameK || !sameEpoch || !sameHeight || txsDiffer || schemaDiffers) {
      warnings.push({
        code: 'STATUS_SCHEMA_DIVERGENCE',
        path: rootStatusPath,
        detail: 'root /api/status differs from chain status (schema and/or tx counts)'
      });
    }
  }

  const status = isObject(chainStatus) && !chainStatus.__parseError ? chainStatus : (isObject(rootStatus) && !rootStatus.__parseError ? rootStatus : null);
  const params = isObject(paramsJson) && !paramsJson.__parseError ? paramsJson : null;
  if (paramsHit?.result?.ok && paramsJson?.__parseError) {
    warnings.push({ code: 'PARAMS_INVALID_JSON', path: paramsHit.path });
  }

  const clientResults = [];
  if (primaryClient.ok) clientResults.push({ path: clientPaths[0], result: primaryClient });
  if (fallbackClient?.ok) clientResults.push({ path: clientPaths[1], result: fallbackClient });
  const clientSha = clientResults[0]?.result.sha256 || null;
  if (clientResults.length >= 2 && clientResults[0].result.sha256 !== clientResults[1].result.sha256) {
    warnings.push({ code: 'CLIENT_BUNDLE_MISMATCH', detail: 'client bundle hashes disagree across URLs' });
  }
  if (clientSha && engineSha256 && clientSha !== engineSha256) {
    warnings.push({
      code: 'CLIENT_ENGINE_HASH_MISMATCH',
      detail: 'served client bundle sha256 differs from advertised engine_sha256'
    });
  }

  // Sample explorer list, then a receipt and explorer tx. Prefer a transfer if one is listed.
  const transferListHit = await getPath(
    source,
    '/api/explorer/txs?type=transfer&limit=50',
    endpoints,
    warnings,
    req
  );
  const allListHit = await getPath(source, '/api/explorer/txs', endpoints, warnings, req);

  let receiptFields = [];
  let explorerTxFields = [];
  let explorerBodyFields = [];
  let explorerType = null;
  let transferBodyFields = null;
  let transferObserved = false;
  let receiptObserved = false;
  let explorerObserved = false;

  const transferList = jsonFrom(transferListHit);
  const allList = jsonFrom(allListHit);
  const transfers = Array.isArray(transferList) ? transferList : [];
  const listed = Array.isArray(allList) ? allList : [];
  const transferRow = transfers.find((row) => isObject(row) && row.type === 'transfer')
    || listed.find((row) => isObject(row) && row.type === 'transfer');
  const sampleRow = transferRow || listed.find((row) => isObject(row) && typeof row.id === 'string');
  const sampleId = sampleRow && /^[0-9a-f]{64}$/i.test(sampleRow.id) ? sampleRow.id : null;

  if (sampleId) {
    const receiptHit = await firstOk(
      source,
      [`/api/receipt/${sampleId}`, `/chain/${chainId}/api/receipt/${sampleId}`],
      endpoints,
      warnings,
      req
    );
    const receiptJson = jsonFrom(receiptHit?.result);
    if (isObject(receiptJson) && !receiptJson.__parseError) {
      receiptFields = fieldsOf(receiptJson);
      receiptObserved = true;
    }
    const explorerHit = await firstOk(
      source,
      [`/api/explorer/tx/${sampleId}`, `/chain/${chainId}/api/explorer/tx/${sampleId}`],
      endpoints,
      warnings,
      req
    );
    const explorerJson = jsonFrom(explorerHit?.result);
    if (isObject(explorerJson) && !explorerJson.__parseError) {
      explorerTxFields = fieldsOf(explorerJson);
      explorerObserved = true;
      explorerType = typeof explorerJson.type === 'string' ? explorerJson.type : null;
      if (isObject(explorerJson.body)) {
        explorerBodyFields = fieldsOf(explorerJson.body);
        if (explorerJson.body.type === 'transfer' || explorerType === 'transfer') {
          transferBodyFields = explorerBodyFields;
          transferObserved = true;
        }
      }
    }
    // Record template paths in endpoints for capability checks.
    for (const [template, concrete] of [
      ['/api/receipt/:id', `/api/receipt/${sampleId}`],
      [`/chain/${chainId}/api/receipt/:id`, `/chain/${chainId}/api/receipt/${sampleId}`],
      ['/api/explorer/tx/:id', `/api/explorer/tx/${sampleId}`],
      [`/chain/${chainId}/api/explorer/tx/:id`, `/chain/${chainId}/api/explorer/tx/${sampleId}`]
    ]) {
      if (endpoints[concrete] && !endpoints[template]) endpoints[template] = endpoints[concrete];
    }
  } else if (allListHit?.ok) {
    warnings.push({
      code: 'NO_SAMPLE_TX',
      path: '/api/explorer/txs',
      detail: 'explorer listing had no usable tx id; receipt and explorer tx shapes were not observed'
    });
  }

  // Optional flaky parents endpoint — fetched last so a 503 does not block core reads.
  await getPath(source, '/api/txs', endpoints, warnings, req);

  const decimals = Number.isInteger(params?.decimals) ? params.decimals : null;
  const K =
    factsK ??
    (Number.isInteger(status?.K) ? status.K : null) ??
    (Number.isInteger(params?.K) ? params.K : null);

  return {
    ok: true,
    error: null,
    source,
    chainId: factsChainId,
    engineSha256,
    paramsSha256,
    clientBundleSha256: clientSha,
    clientBundleUrls: clientResults.map((c) => c.path),
    K,
    decimals,
    receiptFields,
    receiptObserved,
    explorerTxFields,
    explorerBodyFields,
    explorerType,
    explorerObserved,
    transferBodyFields,
    transferObserved,
    endpoints,
    warnings,
    status: status && !status.__parseError
      ? {
          chainId: status.chain_id ?? null,
          K: status.K ?? null,
          epochsClosed: status.epochs_closed ?? null,
          txs: status.txs ?? null,
          final: status.final ?? null,
          checkpointHeight: status.checkpoint?.height ?? status.checkpoint_height ?? null
        }
      : null
  };
}

export function liveToBaseline(live, previous = {}) {
  return {
    source: live.source || previous.source || DEFAULT_SOURCE,
    chainId: live.chainId,
    engineSha256: live.engineSha256,
    paramsSha256: live.paramsSha256,
    clientBundleSha256: live.clientBundleSha256,
    clientBundleUrls: live.clientBundleUrls?.length ? live.clientBundleUrls : previous.clientBundleUrls,
    K: live.K,
    decimals: live.decimals,
    receiptFields: live.receiptObserved ? live.receiptFields : previous.receiptFields,
    explorerTxFields: live.explorerObserved ? live.explorerTxFields : previous.explorerTxFields,
    transferBodyFields: live.transferObserved ? live.transferBodyFields : previous.transferBodyFields,
    capabilities: previous.capabilities || []
  };
}
