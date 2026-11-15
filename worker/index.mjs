import { fetchLive } from '../src/fetch-live.mjs';
import { compare } from '../src/compare.mjs';
import { formatJson } from '../src/format.mjs';
import { bundledCatalog } from '../src/catalog.mjs';
import { nextHistory } from '../src/history.mjs';

const LATEST_KEY = 'latest';
const HISTORY_KEY = 'history';

export async function runCheck() {
  const { baseline, apps } = bundledCatalog();
  const live = await fetchLive();
  const compared = compare({ live, baseline, apps });
  return JSON.parse(formatJson(compared));
}

export async function persist(env, report) {
  const previous = await env.RESULTS.get(LATEST_KEY, 'json');
  const history = (await env.RESULTS.get(HISTORY_KEY, 'json')) || [];
  const next = nextHistory(previous, history, report);
  await env.RESULTS.put(LATEST_KEY, JSON.stringify(report));
  if (next.changed) {
    await env.RESULTS.put(HISTORY_KEY, JSON.stringify(next.history));
  }
  return next;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60'
    }
  });
}

export default {
  async scheduled(_event, env) {
    const report = await runCheck();
    await persist(env, report);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'Content-Type'
        }
      });
    }

    if (request.method !== 'GET') {
      return textResponse('Method not allowed\n', 405);
    }

    if (path === '/' || path === '/index.html') {
      return textResponse(
        [
          'poa-compat-watch',
          'Read-only Proof of Agent compatibility checker.',
          '',
          'GET /latest.json   latest check result',
          'GET /history.json  last-change history',
          ''
        ].join('\n')
      );
    }

    if (path === '/latest' || path === '/latest.json') {
      let latest = await env.RESULTS.get(LATEST_KEY, 'json');
      if (!latest) {
        latest = await runCheck();
        await persist(env, latest);
      }
      return jsonResponse(latest);
    }

    if (path === '/history' || path === '/history.json') {
      const history = (await env.RESULTS.get(HISTORY_KEY, 'json')) || [];
      return jsonResponse({ history });
    }

    return textResponse('Not found\n', 404);
  }
};
