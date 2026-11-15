import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRACKS = new Set(['engine', 'params', 'client']);

export class ConfigError extends Error {}

export function loadConfig(file, { root } = {}) {
  const abs = path.resolve(file);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new ConfigError(`cannot read config ${file}: ${e.message}`); }
  return normalizeConfig(raw, { root: root ? path.resolve(root) : path.dirname(abs) });
}

export function normalizeConfig(raw, { root = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must be a JSON object');
  const project = String(raw.project || path.basename(root));
  const pins = (raw.pins || []).map((p, i) => {
    if (!p || typeof p !== 'object') throw new ConfigError(`pins[${i}] must be an object`);
    if (!TRACKS.has(p.tracks)) throw new ConfigError(`pins[${i}].tracks must be one of engine, params, client`);
    if (!p.file) throw new ConfigError(`pins[${i}].file is required`);
    const kinds = ['json', 'regex', 'replaceAll'].filter((k) => p[k] !== undefined && p[k] !== false);
    if (kinds.length !== 1) throw new ConfigError(`pins[${i}] needs exactly one of json, regex or replaceAll`);
    if (p.regex) {
      let re;
      try { re = new RegExp(p.regex, (p.flags || '').replace('g', '')); } catch (e) { throw new ConfigError(`pins[${i}].regex invalid: ${e.message}`); }
      if (new RegExp(re.source + '|').exec('').length < 2) throw new ConfigError(`pins[${i}].regex needs one capture group around the value`);
    }
    const resolved = path.resolve(root, p.file);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new ConfigError(`pins[${i}].file must stay inside the project`);
    return { id: p.id || `${p.tracks}@${p.file}`, tracks: p.tracks, file: p.file, json: p.json, regex: p.regex, flags: p.flags || '', replaceAll: !!p.replaceAll, optional: !!p.optional };
  });
  const surface = raw.surface ? {
    snapshot: raw.surface.snapshot || '.poa-compat/surface.json',
    uses: raw.surface.uses || {},
    shapes: raw.surface.shapes || undefined,
  } : null;
  const tests = (raw.tests || []).map((t) => (typeof t === 'string' ? { run: t } : t));
  for (const [i, t] of tests.entries()) if (!t || typeof t.run !== 'string' || !t.run.trim()) throw new ConfigError(`tests[${i}] must be a command string`);
  const pr = raw.pr || {};
  return {
    project,
    root,
    network: {
      origin: raw.network?.origin || 'https://minepoa.com',
      chainId: raw.network?.chainId || 'poa-mainnet-1',
      factsUrls: raw.network?.factsUrls,
      statusUrls: raw.network?.statusUrls,
      releaseUrls: raw.network?.releaseUrls,
      clientUrls: raw.network?.clientUrls,
      expectFacts: raw.network?.expectFacts || {},
      expectStatus: raw.network?.expectStatus || {},
      // "engine": served client sha256 must equal the advertised engine hash; "release": must equal the
      // release manifest's client_sha256; "none": not checked.
      clientMustMatch: raw.network?.clientMustMatch ?? 'release',
    },
    pins,
    failClosedOnPinMismatch: !!raw.failClosedOnPinMismatch,
    surface,
    evidence: raw.evidence || '.poa-compat/evidence.json',
    report: raw.report || path.join(os.tmpdir(), 'poa-compat', safe(project), 'report.json'),
    tests,
    testTimeoutMinutes: Number(raw.testTimeoutMinutes || 30),
    pr: {
      base: pr.base || 'main',
      branch: pr.branch || 'poa-compat/update',
      titlePrefix: pr.titlePrefix || 'PoA core update',
      labels: pr.labels || [],
      draft: !!pr.draft,
      allowUnknownSurface: !!pr.allowUnknownSurface,
    },
  };
}

const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
