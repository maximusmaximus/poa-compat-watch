import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/check.mjs';
import { compatibleLive } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function writeFixture(live) {
  const dir = mkdtempSync(join(tmpdir(), 'poa-compat-'));
  const file = join(dir, 'live.json');
  writeFileSync(file, JSON.stringify(live));
  return file;
}

describe('CLI', () => {
  it('prints help', async () => {
    const result = await run(['--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Exit codes/);
  });

  it('exits 0 and prints a human report for a compatible fixture', async () => {
    const fixture = writeFixture(compatibleLive());
    const result = await run(['--fixture', fixture], { cwd: ROOT });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Overall: compatible \(exit 0\)/);
    assert.match(result.stdout, /poa-domains: compatible/);
    assert.match(result.stdout, /poa-dice: compatible/);
  });

  it('prints JSON and exits 1 on hash drift', async () => {
    const fixture = writeFixture(
      compatibleLive({
        engineSha256: 'aa'.repeat(32),
        clientBundleSha256: 'aa'.repeat(32)
      })
    );
    const result = await run(['--fixture', fixture, '--json'], { cwd: ROOT });
    assert.equal(result.exitCode, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.classification, 'needs-update');
    assert.equal(body.exitCode, 1);
    assert.equal(body.apps.find((app) => app.id === 'poa-domains').classification, 'needs-update');
    assert.equal(body.apps.find((app) => app.id === 'poa-dice').classification, 'compatible');
    assert.equal(body.live.engineSha256, 'aa'.repeat(32));
  });

  it('exits 2 on a breaking chain id change', async () => {
    const fixture = writeFixture(compatibleLive({ chainId: 'other-chain' }));
    const result = await run(['--fixture', fixture], { cwd: ROOT });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /Overall: breaking \(exit 2\)/);
  });

  it('exits 3 when the fixture reports a failed observation', async () => {
    const fixture = writeFixture({ ok: false, error: 'unable to read network-facts from the live node after retries', warnings: [] });
    const result = await run(['--fixture', fixture], { cwd: ROOT });
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /Checker error/);
  });

  it('writes a reviewed baseline from a successful observation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poa-compat-'));
    mkdirSync(join(dir, 'apps'));
    writeFileSync(join(dir, 'baseline.json'), readFileSync(join(ROOT, 'baseline.json')));
    writeFileSync(join(dir, 'apps/poa-domains.json'), readFileSync(join(ROOT, 'apps/poa-domains.json')));
    writeFileSync(join(dir, 'apps/poa-dice.json'), readFileSync(join(ROOT, 'apps/poa-dice.json')));
    const live = compatibleLive({ engineSha256: 'cc'.repeat(32), clientBundleSha256: 'cc'.repeat(32) });
    const fixture = join(dir, 'live.json');
    writeFileSync(fixture, JSON.stringify(live));
    const result = await run([
      '--fixture', fixture,
      '--baseline', join(dir, 'baseline.json'),
      '--apps', join(dir, 'apps'),
      '--write-baseline'
    ], { cwd: dir });
    assert.equal(result.exitCode, 1);
    const written = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8'));
    assert.equal(written.engineSha256, 'cc'.repeat(32));
    assert.equal(written.chainId, 'poa-mainnet-1');
    assert.ok(Array.isArray(written.capabilities));
    assert.match(result.stdout, /wrote /);
  });
});
