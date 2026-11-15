// Small fetch helper: bounded reads, retries on busy/transient answers, never follows to other origins silently.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds the server asked us to wait (Retry-After header or a JSON retry_after_seconds field). */
export function retryAfterMs(response, bodyText) {
  const h = response.headers?.get?.('retry-after');
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  if (bodyText) {
    try {
      const j = JSON.parse(bodyText);
      const s = j?.retry_after_seconds ?? j?.retry_after;
      if (Number.isFinite(Number(s))) return Number(s) * 1000;
    } catch { /* not JSON */ }
  }
  return 0;
}

/**
 * GET a URL with retries. Returns { status, bytes:Uint8Array, headers }.
 * 404 is returned (not thrown) so callers can try fallback paths.
 */
export async function getBytes(url, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    retries = 3,
    timeoutMs = 30000,
    maxBytes = 8 * 1024 * 1024,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    headers = {},
    sleepImpl = sleep,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'poa-compat-watch', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > maxBytes) throw new HttpError(`response too large from ${url}`, { status: response.status, url });
      if (response.status === 404) return { status: 404, bytes: buf, headers: response.headers };
      if (response.ok) return { status: response.status, bytes: buf, headers: response.headers };
      const text = new TextDecoder().decode(buf.slice(0, 4096));
      lastErr = new HttpError(`HTTP ${response.status} from ${url}`, { status: response.status, url });
      if (!RETRY_STATUS.has(response.status) || attempt === retries) throw lastErr;
      const wait = Math.min(maxDelayMs, Math.max(retryAfterMs(response, text), baseDelayMs * 2 ** attempt));
      await sleepImpl(wait);
    } catch (e) {
      if (e instanceof HttpError && (!RETRY_STATUS.has(e.status) || attempt === retries)) throw e;
      lastErr = e;
      if (attempt === retries) break;
      if (!(e instanceof HttpError)) await sleepImpl(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(`request failed: ${url}`, { url });
}

export async function getJson(url, opts = {}) {
  const r = await getBytes(url, { maxBytes: 4 * 1024 * 1024, ...opts });
  if (r.status === 404) return null;
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes));
}

/** Try each URL in turn; 404s and transient failures fall through to the next one. */
export async function getFirstJson(urls, opts = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      const v = await getJson(url, opts);
      if (v !== null && v !== undefined) return { url, value: v };
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return { url: null, value: null };
}
