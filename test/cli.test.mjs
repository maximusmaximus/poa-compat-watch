import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMock } from './helpers/mock-network.mjs';
import { main } from '../src/cli.mjs';
import { makeProject } from './helpers/project.mjs';
import { getBytes } from '../src/http.mjs';
import { scanText } from '../src/secret-scan.mjs';
import { redact } from '../src/redact.mjs';
import { autoMergeDecision } from '../src/pr.mjs';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
const P1 = '1'.repeat(64), P2 = '2'.repeat(64);
const fastHttp = { http: { baseDelayMs: 1, maxDelayMs: 5 } };

function capture() {
  let out = '', err = '';
  return { io: { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } }, get out() { return out; }, get err() { return err; } };
}

async function project({ engine, params, failClosed = true, tests = [], withPins = true }) {
  const root = makeProject({
    'config.jsonc': `{\n  // fixture app\n  "vars": { "ENGINE": "${engine}", "PARAMS": "${params}" }\n}\n`,
    'src/pins.mjs': `export const ENGINE = "${engine}";\nexport const PARAMS = "${params}";\n`,
  });
  const cfg = {
    project: 'fixture-app',
    network: { chainId: 'poa-mainnet-1', clientMustMatch: 'engine', expectFacts: { 'economics.K': 5 } },
    failClosedOnPinMismatch: failClosed,
    pins: withPins ? [
      { tracks: 'engine', file: 'config.jsonc', json: 'vars.ENGINE' },
      { tracks: 'params', file: 'config.jsonc', json: 'vars.PARAMS' },
      { tracks: 'engine', file: 'src/pins.mjs', regex: 'ENGINE = "([0-9a-f]{64})"' },
      { tracks: 'params', file: 'src/pins.mjs', regex: 'PARAMS = "([0-9a-f]{64})"' },
    ] : [],
    surface: { snapshot: '.poa-compat/surface.json', uses: { exports: ['canonical', 'txidOf', 'buildTx'], critical: ['canonical', 'txidOf'], txTypes: ['transfer'], fields: { body: ['type', 'from', 'to', 'amount', 'nonce'] } } },
    evidence: '.poa-compat/evidence.json',
    report: path.join(root, '.out', 'report.json'),
    tests,
  };
  fs.writeFileSync(path.join(root, 'poa-compat.json'), JSON.stringify(cfg, null, 2));
  return root;
}

async function inProject(root, fn) {
  const prev = process.cwd();
  process.chdir(root);
  try { return await fn(); } finally { process.chdir(prev); }
}

test('status reads facts, release and client; retries 503s', async () => {
  const m = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1, busyFirst: 2 });
  try {
    const c = capture();
    const code = await main(['status', '--origin', m.origin, '--json', '--pinned', 'a'.repeat(64)], c.io, fastHttp);
    assert.equal(code, 0, c.err);
    const s = JSON.parse(c.out);
    assert.equal(s.engineSha256, m.engine);
    assert.equal(s.clientSha256, m.clientSha);
    assert.equal(s.paramsSha256, P1);
    assert.equal(s.release.version, 'vTEST');
    assert.equal(s.pinned.release, 'vOLD');
    assert.equal(s.pinned.releasesBehind, 1);
  } finally { await m.close(); }
});

test('check: compatible, needs-update and breaking (fail-closed pins)', async () => {
  const m = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
  try {
    const root = await project({ engine: m.engine, params: P1 });
    await inProject(root, async () => {
      let c = capture();
      assert.equal(await main(['snapshot', '--origin', m.origin], c.io, fastHttp), 0, c.err);
      c = capture();
      assert.equal(await main(['check', '--origin', m.origin], c.io, fastHttp), 0, c.out + c.err);
      assert.match(c.out, /Compatible/);
    });
  } finally { await m.close(); }

  const m2 = await startMock({ bundle: fx('bundle-v2-compatible.mjs'), params: P2 });
  try {
    const old = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
    const rootSoft = await project({ engine: old.engine, params: P1, failClosed: false });
    const rootHard = await project({ engine: old.engine, params: P1, failClosed: true });
    for (const r of [rootSoft, rootHard]) await inProject(r, () => main(['snapshot', '--origin', old.origin], capture().io, fastHttp));
    await old.close();
    let c = capture();
    assert.equal(await inProject(rootSoft, () => main(['check', '--origin', m2.origin, '--json'], c.io, fastHttp)), 10, c.err);
    assert.equal(JSON.parse(c.out).classification, 'needs-update');
    c = capture();
    assert.equal(await inProject(rootHard, () => main(['check', '--origin', m2.origin], c.io, fastHttp)), 20, c.err);
    assert.match(c.out, /refuses to run on unpinned values/);
  } finally { await m2.close(); }
});

test('check: surface break is breaking even without pins', async () => {
  const old = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
  const root = await project({ engine: old.engine, params: P1, withPins: false });
  await inProject(root, () => main(['snapshot', '--origin', old.origin], capture().io, fastHttp));
  await old.close();
  const m = await startMock({ bundle: fx('bundle-v3-breaking.mjs'), params: P1 });
  try {
    const c = capture();
    assert.equal(await inProject(root, () => main(['check', '--origin', m.origin], c.io, fastHttp)), 20);
    assert.match(c.out, /critical function `canonical` changed/);
    assert.match(c.out, /transaction type `transfer` no longer appears/);
  } finally { await m.close(); }
});

test('check: network expectation change is breaking', async () => {
  const m = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1, K: 7 });
  try {
    const root = await project({ engine: m.engine, params: P1 });
    const c = capture();
    assert.equal(await inProject(root, () => main(['check', '--origin', m.origin], c.io, fastHttp)), 20);
    assert.match(c.out, /economics\.K/);
  } finally { await m.close(); }
});

test('update rewrites pins, refreshes snapshot, records evidence, runs tests; pr dry run plans auto-merge', async () => {
  const old = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
  const root = await project({ engine: old.engine, params: P1, tests: ['node -e "process.exit(0)"', 'node -e "console.log(1)"'] });
  await inProject(root, () => main(['snapshot', '--origin', old.origin], capture().io, fastHttp));
  const oldEngine = old.engine;
  await old.close();
  const m = await startMock({ bundle: fx('bundle-v2-compatible.mjs'), params: P2 });
  try {
    const c = capture();
    const code = await inProject(root, () => main(['update', '--origin', m.origin], c.io, fastHttp));
    assert.equal(code, 20, c.out + c.err);
    const cfgText = fs.readFileSync(path.join(root, 'config.jsonc'), 'utf8');
    assert.ok(cfgText.includes(m.engine) && cfgText.includes(P2) && !cfgText.includes(oldEngine) && cfgText.includes('// fixture app'));
    assert.ok(fs.readFileSync(path.join(root, 'src/pins.mjs'), 'utf8').includes(m.engine));
    const snap = JSON.parse(fs.readFileSync(path.join(root, '.poa-compat/surface.json'), 'utf8'));
    assert.equal(snap.clientSha256, m.clientSha);
    const ev = JSON.parse(fs.readFileSync(path.join(root, '.poa-compat/evidence.json'), 'utf8'));
    assert.equal(ev.entries.at(-1).from.engine, oldEngine);
    assert.equal(ev.entries.at(-1).to.engine, m.engine);
    const report = JSON.parse(fs.readFileSync(path.join(root, '.out/report.json'), 'utf8'));
    assert.equal(report.tests.passed, true);
    assert.deepEqual(report.changedFiles.sort(), ['.poa-compat/evidence.json', '.poa-compat/surface.json', 'config.jsonc', 'src/pins.mjs']);
    assert.equal(autoMergeDecision(report, { when: 'breaking' }).enable, true);
    assert.equal(autoMergeDecision(report, { when: 'never' }).enable, false);

    const calls = [];
    const run = (cmd, args) => { calls.push([cmd, ...args].join(' ')); if (args[0] === 'pr' && args[1] === 'list') return '[]'; if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/7'; return ''; };
    const p = capture();
    assert.equal(await inProject(root, () => main(['pr', '--auto-merge-when', 'breaking', '--dispatch-workflow', 'ci.yml'], p.io, { ...fastHttp, run })), 0, p.err);
    assert.ok(calls.some((x) => x.startsWith('git push --force origin HEAD:refs/heads/poa-compat/update')));
    assert.ok(calls.some((x) => x.startsWith('gh pr create --base main --head poa-compat/update')));
    assert.ok(calls.includes('gh workflow run ci.yml --ref poa-compat/update'));
    assert.ok(calls.includes('gh pr merge 7 --auto --squash'));
    assert.match(p.out, /pull\/7/);
  } finally { await m.close(); }
});

test('failing tests block auto-merge and exit 3', async () => {
  const old = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
  const root = await project({ engine: old.engine, params: P1, tests: ['node -e "process.exit(4)"', 'node -e "process.exit(0)"'] });
  await inProject(root, () => main(['snapshot', '--origin', old.origin], capture().io, fastHttp));
  await old.close();
  const m = await startMock({ bundle: fx('bundle-v2-compatible.mjs'), params: P2 });
  try {
    const c = capture();
    assert.equal(await inProject(root, () => main(['update', '--origin', m.origin], c.io, fastHttp)), 3);
    const report = JSON.parse(fs.readFileSync(path.join(root, '.out/report.json'), 'utf8'));
    assert.equal(report.tests.passed, false);
    assert.equal(report.tests.results.length, 1);
    const d = autoMergeDecision(report, { when: 'breaking' });
    assert.equal(d.enable, false);
    assert.match(d.reason, /did not all pass/);
  } finally { await m.close(); }
});

test('surface break blocks auto-merge even when tests pass', async () => {
  const old = await startMock({ bundle: fx('bundle-v1.mjs'), params: P1 });
  const root = await project({ engine: old.engine, params: P1, tests: ['node -e "0"'] });
  await inProject(root, () => main(['snapshot', '--origin', old.origin], capture().io, fastHttp));
  await old.close();
  const m = await startMock({ bundle: fx('bundle-v3-breaking.mjs'), params: P1 });
  try {
    await inProject(root, () => main(['update', '--origin', m.origin], capture().io, fastHttp));
    const report = JSON.parse(fs.readFileSync(path.join(root, '.out/report.json'), 'utf8'));
    assert.equal(report.check.classification, 'breaking');
    assert.equal(autoMergeDecision(report, { when: 'breaking' }).enable, false);
  } finally { await m.close(); }
});

test('update refuses when the served client does not match the advertised engine', async () => {
  const m = await startMock({ bundle: fx('bundle-v2-compatible.mjs'), params: P2, engine: 'e'.repeat(64) });
  const root = await project({ engine: 'a'.repeat(64), params: P1 });
  try {
    const c = capture();
    const code = await inProject(root, () => main(['update', '--origin', m.origin], c.io, fastHttp));
    assert.equal(code, 1);
    assert.match(c.err, /refusing to update/);
    assert.ok(fs.readFileSync(path.join(root, 'config.jsonc'), 'utf8').includes('a'.repeat(64)));
  } finally { await m.close(); }
});

test('client download failure leaves surface unknown and blocks auto-merge', async () => {
  const m = await startMock({ bundle: fx('bundle-v2-compatible.mjs'), params: P2, clientStatus: 500 });
  const root = await project({ engine: 'a'.repeat(64), params: P1, tests: ['node -e "0"'] });
  try {
    const c = capture();
    const code = await inProject(root, () => main(['check', '--origin', m.origin, '--json'], c.io, { http: { baseDelayMs: 1, maxDelayMs: 2, retries: 0 } }));
    assert.equal(code, 20);
    assert.match(JSON.parse(c.out).surface.state, /unknown/);
  } finally { await m.close(); }
});

test('diff between two bundle files', async () => {
  const c = capture();
  const code = await main(['diff', '--old', new URL('./fixtures/bundle-v1.mjs', import.meta.url).pathname, '--new', new URL('./fixtures/bundle-v3-breaking.mjs', import.meta.url).pathname, '--json'], c.io);
  assert.equal(code, 20);
  const d = JSON.parse(c.out);
  assert.equal(d.breaking, true);
});

test('http helper gives up after retries on persistent 503', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return new Response('{"retry_after_seconds":0}', { status: 503 }); };
  await assert.rejects(getBytes('http://x', { fetchImpl, retries: 2, baseDelayMs: 1, sleepImpl: async () => {} }), /HTTP 503/);
  assert.equal(n, 3);
});

test('secret scan and redaction', () => {
  const fake = 'ghp_' + 'A'.repeat(36);
  assert.equal(scanText(`token = "${fake}"`).length, 1);
  assert.equal(scanText(`engine = "${'a'.repeat(64)}"`).length, 0);
  assert.ok(!redact(`Authorization: Bearer ${fake}`).includes(fake));
});
