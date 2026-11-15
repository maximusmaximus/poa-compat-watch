import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeConfig, ConfigError } from './config.mjs';
import { readLive, liveSummary, releasesSince, releasesForEngine, sha256Hex } from './live.mjs';
import { runCheck, runUpdate, publicResult, makeSnapshot, readSnapshot, EXIT } from './check.mjs';
import { extractSurface } from './surface.mjs';
import { compareSurfaces } from './compare.mjs';
import { renderCheck, renderDiff, renderUpdate } from './report.mjs';
import { openPr, autoMergeDecision } from './pr.mjs';
import { getBytes } from './http.mjs';
import { redact } from './redact.mjs';

const HELP = `poa-compat: watch the Proof of Agent (PoA) core for changes that affect your project.

Usage:
  poa-compat status [--json] [--pinned <engine-sha256>] [--no-client] [--origin URL] [--chain ID]
  poa-compat check  [--config poa-compat.json] [--json]
  poa-compat diff   [--config poa-compat.json] [--old FILE|URL|SNAPSHOT] [--new FILE|URL] [--json]
  poa-compat update [--config poa-compat.json] [--skip-tests] [--force] [--json]
  poa-compat pr     [--config poa-compat.json] [--report FILE] [--auto-merge-when never|breaking]
                    [--dispatch-workflow FILE] [--dry-run]
  poa-compat snapshot [--config poa-compat.json] [--bundle FILE]

Exit codes (check, and update when nothing failed):
  0  compatible      10  needs update      20  breaking
  1  usage/config error   2  network unavailable   3  tests failed after update`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const flags = new Set(['json', 'skip-tests', 'force', 'dry-run', 'no-client', 'help']);
      if (flags.has(k)) opts[k] = true;
      else opts[k] = inline ?? rest[++i];
    } else opts._.push(a);
  }
  return { cmd, opts };
}

function out(io, s) { io.stdout.write(redact(s) + '\n'); }

function ghOutputs(pairs) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  fs.appendFileSync(f, Object.entries(pairs).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n');
}
function ghSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, redact(md) + '\n');
}

function cfgFrom(opts) {
  const file = opts.config || 'poa-compat.json';
  if (!fs.existsSync(file)) {
    if (opts.config) throw new ConfigError(`config ${file} not found`);
    return normalizeConfig({ network: { origin: opts.origin, chainId: opts.chain } }, { root: process.cwd() });
  }
  const cfg = loadConfig(file, { root: opts.root });
  if (opts.origin) cfg.network.origin = opts.origin;
  if (opts.chain) cfg.network.chainId = opts.chain;
  return cfg;
}

async function loadSource(spec, http) {
  if (/^https?:\/\//.test(spec)) {
    const r = await getBytes(spec, { timeoutMs: 120000, retries: 2, maxBytes: 16 * 1024 * 1024, ...http });
    if (r.status === 404) throw new Error(`${spec} returned 404`);
    return { label: spec, text: new TextDecoder().decode(r.bytes), sha256: sha256Hex(r.bytes) };
  }
  const buf = fs.readFileSync(spec);
  if (spec.endsWith('.json')) {
    const j = JSON.parse(buf.toString('utf8'));
    if (j.surface) return { label: spec, surface: j.surface, sha256: j.clientSha256 ?? null };
  }
  return { label: spec, text: buf.toString('utf8'), sha256: sha256Hex(buf) };
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }, deps = {}) {
  const { cmd, opts } = parseArgs(argv);
  const http = deps.http || {};
  if (!cmd || cmd === 'help' || opts.help || cmd === '--help') { out(io, HELP); return cmd ? 0 : 1; }
  try {
    if (cmd === 'status') {
      const cfg = cfgFrom(opts);
      const live = await readLive(cfg.network, { http, withClient: !opts['no-client'] });
      const s = liveSummary(live);
      if (opts.pinned) { s.pinned = { engineSha256: opts.pinned, release: releasesForEngine(live.release, opts.pinned).at(-1)?.version ?? null, releasesBehind: releasesSince(live.release, opts.pinned) }; }
      if (opts.json) out(io, JSON.stringify(s, null, 2));
      else {
        out(io, [
          `Network:        ${s.chainId} (open epoch ${s.openEpoch ?? '?'})`,
          `Release:        ${s.release?.version ?? 'unknown'}`,
          `Engine sha256:  ${s.engineSha256}`,
          `Params sha256:  ${s.paramsSha256}`,
          `Client sha256:  ${s.clientSha256 ?? `unavailable${s.clientError ? ` (${s.clientError})` : ''}`}${s.clientSize ? ` (${s.clientSize} bytes)` : ''}`,
          `Checkpoint:     ${s.status?.checkpoint?.height ?? s.status?.checkpoint_height ?? 'unknown'}`,
          ...(s.pinned ? [`Pinned engine:  ${s.pinned.engineSha256.slice(0, 12)}… (${s.pinned.release ?? 'not in release history'}${s.pinned.releasesBehind >= 0 ? `, ${s.pinned.releasesBehind} releases behind` : ''})`] : []),
          ...s.warnings.map((w) => `Note: ${w}`),
        ].join('\n'));
      }
      return 0;
    }
    if (cmd === 'check') {
      const cfg = cfgFrom(opts);
      const r = await runCheck(cfg, { http });
      const md = renderCheck(r);
      out(io, opts.json ? JSON.stringify(publicResult(r), null, 2) : md);
      ghOutputs({ classification: r.classification, 'exit-code': r.exitCode });
      ghSummary(md);
      return r.exitCode;
    }
    if (cmd === 'diff') {
      const cfg = cfgFrom(opts);
      let oldS, newS, oldLabel, newLabel;
      if (opts.old) { const o = await loadSource(opts.old, http); oldS = o.surface || extractSurface(o.text, { shapes: cfg.surface?.shapes }); oldLabel = o.label; }
      else {
        const snap = readSnapshot(cfg);
        if (!snap) throw new ConfigError('no --old given and no surface snapshot configured/found');
        oldS = snap.surface; oldLabel = `snapshot ${cfg.surface.snapshot} (client ${String(snap.clientSha256).slice(0, 12)}…)`;
      }
      if (opts.new) { const n = await loadSource(opts.new, http); newS = n.surface || extractSurface(n.text, { shapes: cfg.surface?.shapes }); newLabel = n.label; }
      else {
        const live = await readLive(cfg.network, { http, withClient: true });
        if (!live.client || live.client.error) { io.stderr.write('client bundle unavailable\n'); return EXIT.UNAVAILABLE; }
        newS = extractSurface(new TextDecoder().decode(live.client.bytes), { shapes: cfg.surface?.shapes });
        newLabel = `live ${live.client.url} (${live.client.sha256.slice(0, 12)}…)`;
      }
      const d = compareSurfaces(oldS, newS, cfg.surface?.uses || {});
      if (opts.json) out(io, JSON.stringify({ old: oldLabel, new: newLabel, ...d }, null, 2));
      else out(io, `## Client surface diff\n\nOld: ${oldLabel}\nNew: ${newLabel}\n\n${d.changes.length ? renderDiff(d, { maxInfo: 200 }) : 'No structural differences.'}`);
      return d.breaking ? EXIT.BREAKING : d.changes.length ? EXIT.NEEDS_UPDATE : 0;
    }
    if (cmd === 'snapshot') {
      const cfg = cfgFrom(opts);
      if (!cfg.surface) throw new ConfigError('config has no "surface" section');
      const live = await readLive(cfg.network, { http, withClient: !opts.bundle });
      let text;
      if (opts.bundle) { const b = fs.readFileSync(opts.bundle); live.client = { bytes: b, sha256: sha256Hex(b), size: b.length, url: opts.bundle }; text = b.toString('utf8'); }
      else if (!live.client || live.client.error) { io.stderr.write('client bundle unavailable\n'); return EXIT.UNAVAILABLE; }
      else text = new TextDecoder().decode(live.client.bytes);
      const f = path.join(cfg.root, cfg.surface.snapshot);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(makeSnapshot(live, extractSurface(text, { shapes: cfg.surface.shapes })), null, 2) + '\n');
      out(io, `wrote ${cfg.surface.snapshot} (client ${live.client.sha256.slice(0, 12)}…)`);
      return 0;
    }
    if (cmd === 'update') {
      const cfg = cfgFrom(opts);
      const u = await runUpdate(cfg, { http, skipTests: !!opts['skip-tests'], force: !!opts.force, log: (l) => io.stderr.write(`${l}\n`), spawnImpl: deps.spawnImpl });
      const report = { ...u, check: publicResult(u.check) };
      const md = renderUpdate(report);
      fs.mkdirSync(path.dirname(cfg.report), { recursive: true });
      fs.writeFileSync(cfg.report, JSON.stringify(report, null, 2));
      fs.writeFileSync(cfg.report.replace(/\.json$/, '') + '.md', md);
      out(io, opts.json ? JSON.stringify(report, null, 2) : md);
      ghOutputs({ classification: u.check.classification, updated: u.updated, 'tests-passed': u.tests.passed, report: cfg.report });
      ghSummary(md);
      if (!u.updated) return u.check.exitCode === 0 ? 0 : u.check.exitCode;
      if (!u.tests.skipped && !u.tests.passed) return EXIT.TESTS_FAILED;
      return u.check.exitCode;
    }
    if (cmd === 'pr') {
      const cfg = cfgFrom(opts);
      const file = opts.report || cfg.report;
      if (!fs.existsSync(file)) throw new ConfigError(`report ${file} not found; run "poa-compat update" first`);
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bodyFile = file.replace(/\.json$/, '') + '.md';
      const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : renderUpdate(report);
      const when = opts['auto-merge-when'] || 'never';
      const res = openPr({ cfg, report, body: redact(body), when, dispatchWorkflow: opts['dispatch-workflow'], dryRun: !!opts['dry-run'], run: deps.run });
      if (res.skipped) { out(io, `No pull request: ${res.reason}.`); return 0; }
      out(io, [`${opts['dry-run'] ? 'Would open/update' : 'Pull request'}: ${res.pr.url}`, `Branch: ${res.branch}`, `Merge: ${res.autoMerge.reason}`, ...(opts['dry-run'] ? ['Plan:', ...res.plan.map((p) => `  ${p}`)] : [])].join('\n'));
      ghOutputs({ 'pr-url': res.pr.url, 'auto-merge': res.autoMerge.enable });
      return 0;
    }
    out(io, HELP);
    return EXIT.ERROR;
  } catch (e) {
    io.stderr.write(redact(`poa-compat ${cmd}: ${e.message}`) + '\n');
    if (e instanceof ConfigError) return EXIT.ERROR;
    if (/unavailable|fetch failed|HTTP \d|timeout|aborted/i.test(e.message)) return EXIT.UNAVAILABLE;
    return EXIT.ERROR;
  }
}
export { autoMergeDecision };
