import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from '../src/compare.mjs';
import { bundledApps, bundledCatalog } from '../src/catalog.mjs';
import { nextHistory, reportSignature } from '../src/history.mjs';
import { compatibleLive } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('catalog', () => {
  it('includes every apps/*.json manifest', () => {
    const files = readdirSync(join(ROOT, 'apps')).filter((name) => name.endsWith('.json')).sort();
    const ids = bundledApps.map((app) => app.id).sort();
    const fromFiles = files.map((name) => JSON.parse(readFileSync(join(ROOT, 'apps', name), 'utf8')).id).sort();
    assert.deepEqual(ids, fromFiles);
    assert.ok(ids.includes('poa-domains'));
    assert.ok(ids.includes('poa-dice'));
    assert.ok(ids.includes('proof-floor'));
    assert.ok(ids.includes('poa-agent-kit'));
    assert.ok(ids.includes('poa-keygen'));
  });

  it('classifies every bundled app as compatible against the current baseline fixture', () => {
    const { baseline, apps } = bundledCatalog();
    const report = compare({ live: compatibleLive(), baseline, apps });
    assert.equal(report.classification, 'compatible');
    assert.equal(report.exitCode, 0);
    assert.equal(apps.length, 5);
    for (const app of report.apps) assert.equal(app.classification, 'compatible', app.id);
  });
});

describe('history', () => {
  it('records the first result and skips unchanged repeats', () => {
    const { baseline, apps } = bundledCatalog();
    const first = JSON.parse(
      JSON.stringify({
        ...compare({ live: compatibleLive(), baseline, apps }),
        checkedAt: '2026-11-15T08:00:00.000Z'
      })
    );
    const once = nextHistory(null, [], first);
    assert.equal(once.changed, true);
    assert.equal(once.history.length, 1);
    assert.equal(once.history[0].classification, 'compatible');

    const same = nextHistory(first, once.history, { ...first, checkedAt: '2026-11-15T09:00:00.000Z' });
    assert.equal(same.changed, false);
    assert.equal(same.history.length, 1);
  });

  it('appends a history entry when an app classification changes', () => {
    const { baseline, apps } = bundledCatalog();
    const ok = {
      ...compare({ live: compatibleLive(), baseline, apps }),
      checkedAt: '2026-11-15T08:00:00.000Z'
    };
    const drifted = {
      ...compare({
        live: compatibleLive({ engineSha256: 'aa'.repeat(32), clientBundleSha256: 'aa'.repeat(32) }),
        baseline,
        apps
      }),
      checkedAt: '2026-11-15T09:00:00.000Z'
    };
    const first = nextHistory(null, [], ok);
    const second = nextHistory(ok, first.history, drifted);
    assert.equal(second.changed, true);
    assert.equal(second.history.length, 2);
    assert.equal(second.history[0].classification, 'needs-update');
    assert.ok(second.history[0].changes.some((c) => c.field === 'engineSha256'));
    assert.notEqual(reportSignature(ok), reportSignature(drifted));
  });
});
