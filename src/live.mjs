// Reads PoA's public network surface: network facts, node status, release manifest, client bundle.
import { createHash } from 'node:crypto';
import { getBytes, getFirstJson } from './http.mjs';

export const DEFAULT_NETWORK = Object.freeze({
  origin: 'https://minepoa.com',
  chainId: 'poa-mainnet-1',
});

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function networkUrls(network = {}) {
  const origin = String(network.origin || DEFAULT_NETWORK.origin).replace(/\/+$/, '');
  const chain = network.chainId || DEFAULT_NETWORK.chainId;
  const c = encodeURIComponent(chain);
  return {
    origin,
    chainId: chain,
    facts: network.factsUrls || [`${origin}/chain/${c}/api/network-facts`, `${origin}/api/network-facts`, `${origin}/api/network/facts`],
    status: network.statusUrls || [`${origin}/chain/${c}/api/status`, `${origin}/api/status`],
    release: network.releaseUrls || [`${origin}/api/release`],
    client: network.clientUrls || [`${origin}/chain/${c}/client/poa.mjs`, `${origin}/client/poa.mjs`],
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Download the client bundle and hash it. Returns null when every URL failed. */
export async function fetchClient(urls, http = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      const r = await getBytes(url, { timeoutMs: 120000, retries: 2, maxBytes: 16 * 1024 * 1024, ...http });
      if (r.status === 404) continue;
      return { url, bytes: r.bytes, sha256: sha256Hex(r.bytes), size: r.bytes.byteLength, lastModified: r.headers?.get?.('last-modified') || null };
    } catch (e) { lastErr = e; }
  }
  return { error: lastErr ? String(lastErr.message || lastErr) : 'not found' };
}

/**
 * Snapshot of the live network. Never throws for an unavailable optional source; the result says
 * what could not be read. Throws only when network facts (the source of truth for pins) are unreadable.
 */
export async function readLive(network = {}, { http = {}, withClient = true, clock = () => new Date() } = {}) {
  const urls = networkUrls(network);
  const fetchedAt = clock().toISOString();
  const facts = await getFirstJson(urls.facts, http);
  if (!facts.value) throw new Error('network facts unavailable');
  const f = facts.value;
  const out = {
    fetchedAt,
    origin: urls.origin,
    chainId: f.chain_id ?? null,
    expectedChainId: urls.chainId,
    openEpoch: f.open_epoch ?? null,
    engineSha256: f.engine_sha256 ?? null,
    paramsSha256: f.params_sha256 ?? null,
    facts: { url: facts.url, keys: Object.keys(f).sort(), value: f },
    status: null,
    release: null,
    client: null,
    warnings: [],
  };
  if (!HEX64.test(out.engineSha256 || '')) out.warnings.push('network facts carry no valid engine_sha256');
  if (!HEX64.test(out.paramsSha256 || '')) out.warnings.push('network facts carry no valid params_sha256');
  if (out.chainId !== urls.chainId) out.warnings.push(`network facts chain_id is ${out.chainId}, expected ${urls.chainId}`);

  try {
    const s = await getFirstJson(urls.status, http);
    if (s.value) out.status = { url: s.url, keys: Object.keys(s.value).sort(), value: s.value };
  } catch (e) { out.warnings.push(`status unavailable: ${e.message}`); }

  try {
    const r = await getFirstJson(urls.release, http);
    if (r.value && r.value.current) {
      const cur = r.value.current;
      const history = Array.isArray(r.value.history) ? r.value.history : [];
      out.release = {
        url: r.url,
        version: cur.version ?? null,
        engineSha256: cur.engine_sha256 ?? null,
        paramsSha256: cur.params_sha256 ?? null,
        clientSha256: cur.client_sha256 ?? null,
        ts: cur.ts ?? null,
        txid: cur.txid ?? null,
        changelogRef: cur.changelog_ref ?? null,
        history: history.map((h) => ({ version: h.version, engineSha256: h.engine_sha256, paramsSha256: h.params_sha256, clientSha256: h.client_sha256, ts: h.ts })),
      };
      if (out.release.engineSha256 && out.engineSha256 && out.release.engineSha256 !== out.engineSha256)
        out.warnings.push('release manifest engine differs from network facts (a release may be rolling out)');
    }
  } catch (e) { out.warnings.push(`release manifest unavailable: ${e.message}`); }

  if (withClient) {
    const c = await fetchClient(urls.client, http);
    if (c.error) {
      out.warnings.push(`client bundle unavailable: ${c.error}`);
      out.client = { error: c.error };
    } else {
      out.client = c;
      const want = out.release?.clientSha256;
      if (want && want !== c.sha256) out.warnings.push('served client bundle hash differs from the release manifest client_sha256');
    }
  }
  return out;
}

/** Find the release entries (oldest first) that carried a given engine hash. */
export function releasesForEngine(release, engine) {
  if (!release?.history) return [];
  return release.history.filter((h) => h.engineSha256 === engine);
}

/** How many release entries were published after the last one carrying `engine`. -1 when unknown. */
export function releasesSince(release, engine) {
  if (!release?.history?.length) return -1;
  let last = -1;
  release.history.forEach((h, i) => { if (h.engineSha256 === engine) last = i; });
  return last < 0 ? -1 : release.history.length - 1 - last;
}

/** Plain JSON view of the live snapshot (without bundle bytes). */
export function liveSummary(live) {
  const { bytes, ...client } = live.client || {};
  return {
    fetchedAt: live.fetchedAt,
    origin: live.origin,
    chainId: live.chainId,
    openEpoch: live.openEpoch,
    engineSha256: live.engineSha256,
    paramsSha256: live.paramsSha256,
    clientSha256: live.client?.sha256 ?? null,
    clientSize: live.client?.size ?? null,
    clientUrl: live.client?.url ?? null,
    release: live.release ? { version: live.release.version, ts: live.release.ts, clientSha256: live.release.clientSha256, txid: live.release.txid, changelogRef: live.release.changelogRef } : null,
    status: live.status ? pick(live.status.value, ['epochs_closed', 'checkpoint', 'checkpoint_height', 'K', 'network', 'txs', 'final']) : null,
    warnings: live.warnings,
    ...(live.client?.error ? { clientError: client.error } : {}),
  };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k];
  return r;
}
