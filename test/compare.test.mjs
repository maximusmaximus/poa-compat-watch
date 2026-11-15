import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from '../src/compare.mjs';
import { compatibleLive, ENGINE, PARAMS, failEndpoint, RECEIPT_FIELDS } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(ROOT, 'baseline.json'), 'utf8'));
const domains = JSON.parse(readFileSync(join(ROOT, 'apps/poa-domains.json'), 'utf8'));
const dice = JSON.parse(readFileSync(join(ROOT, 'apps/poa-dice.json'), 'utf8'));

function run(live) {
  return compare({ live, baseline, apps: [domains, dice] });
}

function app(report, id) {
  return report.apps.find((row) => row.id === id);
}

describe('compare classifications', () => {
  it('classifies a matching observation as compatible', () => {
    const report = run(compatibleLive());
    assert.equal(report.classification, 'compatible');
    assert.equal(report.exitCode, 0);
    assert.equal(report.baseline.classification, 'compatible');
    assert.equal(app(report, 'poa-domains').classification, 'compatible');
    assert.equal(app(report, 'poa-dice').classification, 'compatible');
  });

  it('treats extra receipt fields as compatible', () => {
    const report = run(compatibleLive({ receiptFields: [...RECEIPT_FIELDS, 'height'] }));
    assert.equal(report.classification, 'compatible');
    assert.equal(report.exitCode, 0);
  });

  it('treats engine and params hash drift as needs-update for the baseline and poa-domains', () => {
    const live = compatibleLive({
      engineSha256: 'aa'.repeat(32),
      paramsSha256: 'bb'.repeat(32),
      clientBundleSha256: 'aa'.repeat(32)
    });
    const report = run(live);
    assert.equal(report.classification, 'needs-update');
    assert.equal(report.exitCode, 1);
    assert.equal(report.baseline.classification, 'needs-update');
    assert.equal(app(report, 'poa-domains').classification, 'needs-update');
    assert.equal(app(report, 'poa-dice').classification, 'compatible');
    const engine = app(report, 'poa-domains').evidence.find((row) => row.field === 'engineSha256');
    assert.equal(engine.expected, ENGINE);
    assert.equal(engine.live, 'aa'.repeat(32));
    assert.equal(engine.result, 'needs-update');
  });

  it('classifies a chain id change as breaking for both apps', () => {
    const report = run(compatibleLive({ chainId: 'poa-mainnet-2' }));
    assert.equal(report.classification, 'breaking');
    assert.equal(report.exitCode, 2);
    assert.equal(report.baseline.classification, 'breaking');
    assert.equal(app(report, 'poa-domains').classification, 'breaking');
    assert.equal(app(report, 'poa-dice').classification, 'breaking');
  });

  it('classifies a decimals change as breaking for poa-dice', () => {
    const report = run(compatibleLive({ decimals: 8 }));
    assert.equal(report.classification, 'breaking');
    assert.equal(report.exitCode, 2);
    assert.equal(app(report, 'poa-dice').classification, 'breaking');
    const row = app(report, 'poa-dice').evidence.find((item) => item.field === 'decimals');
    assert.equal(row.expected, 6);
    assert.equal(row.live, 8);
  });

  it('classifies a missing required dice receipt field as breaking', () => {
    const fields = RECEIPT_FIELDS.filter((name) => name !== 'next_nonce');
    const report = run(compatibleLive({ receiptFields: fields }));
    assert.equal(app(report, 'poa-dice').classification, 'breaking');
    assert.equal(app(report, 'poa-domains').classification, 'compatible');
    assert.equal(report.classification, 'breaking');
    assert.equal(report.exitCode, 2);
  });

  it('accepts the slim receipt shape for poa-domains and not for poa-dice', () => {
    const report = run(
      compatibleLive({
        receiptFields: ['txid', 'status', 'ts', 'height']
      })
    );
    assert.equal(app(report, 'poa-domains').classification, 'compatible');
    assert.equal(app(report, 'poa-dice').classification, 'breaking');
    assert.equal(report.baseline.classification, 'needs-update');
    assert.equal(report.classification, 'breaking');
  });

  it('classifies a transfer body missing cid as breaking when a transfer is observed', () => {
    const fields = ['type', 'from', 'to', 'amount', 'memo', 'nonce', 'parents', 'ts', 'sig'];
    const report = run(compatibleLive({ transferBodyFields: fields, transferObserved: true }));
    assert.equal(report.classification, 'breaking');
    assert.equal(app(report, 'poa-domains').classification, 'breaking');
    assert.equal(app(report, 'poa-dice').classification, 'breaking');
  });

  it('does not fail the transfer check when no transfer was observed', () => {
    const report = run(compatibleLive({ transferObserved: false, transferBodyFields: null }));
    assert.equal(report.classification, 'compatible');
    assert.equal(report.exitCode, 0);
    assert.match(report.baseline.notes.join(' '), /transfer body field set was not re-verified/);
  });

  it('treats a 503 on a flaky endpoint as a warning, not breaking', () => {
    const live = compatibleLive({
      endpoints: {
        '/api/txs': failEndpoint(503, 3)
      }
    });
    const report = run(live);
    assert.equal(report.classification, 'compatible');
    assert.equal(report.exitCode, 0);
    assert.ok(report.warnings.some((row) => row.capability === 'txs-parents' || row.path === '/api/txs' || (row.paths || []).includes('/api/txs')));
  });

  it('treats a persistent failure of a required capability as needs-update', () => {
    const live = compatibleLive({
      endpoints: {
        '/chain/poa-mainnet-1/api/params': failEndpoint(503, 3)
      }
    });
    const report = run(live);
    assert.equal(report.baseline.classification, 'needs-update');
    assert.equal(report.exitCode, 1);
    const row = report.baseline.evidence.find((item) => item.field === 'capability:params');
    assert.equal(row.result, 'needs-update');
  });

  it('returns exit 3 when live observation fails', () => {
    const report = compare({
      live: { ok: false, error: 'unable to read network-facts from the live node after retries', warnings: [] },
      baseline,
      apps: [domains, dice]
    });
    assert.equal(report.classification, 'error');
    assert.equal(report.exitCode, 3);
    assert.match(report.error, /network-facts/);
  });
});
