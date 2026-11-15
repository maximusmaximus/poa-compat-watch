#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLive, liveToBaseline, DEFAULT_SOURCE, DEFAULT_CHAIN, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from './fetch-live.mjs';
import { compare, EXIT } from './compare.mjs';
import { formatJson, formatText } from './format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadApps(dir) {
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return entries.map((name) => {
    const app = loadJson(join(dir, name));
    if (!app.id) app.id = name.replace(/\.json$/, '');
    return app;
  });
}

export function usage() {
  return `Usage: node src/check.mjs [options]

Read-only check of the live Proof of Agent network against the committed
baseline and per-app pin manifests.

Options:
  --json                 print machine-readable JSON
  --source <url>         network origin (default: ${DEFAULT_SOURCE})
  --chain-id <id>        chain id used in /chain/<id>/... paths (default: ${DEFAULT_CHAIN})
  --baseline <file>      baseline file (default: ./baseline.json)
  --apps <dir>           app manifest directory (default: ./apps)
  --fixture <file>       use a saved live observation instead of the network
  --write-baseline       after a successful fetch, write live values into the baseline file
  --retries <n>          retries per endpoint (default: ${DEFAULT_RETRIES})
  --timeout <ms>         per-attempt timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help             show this help

Exit codes:
  0  compatible
  1  needs-update
  2  breaking
  3  checker error
`;
}

export async function run(argv = process.argv.slice(2), options = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        source: { type: 'string' },
        'chain-id': { type: 'string' },
        baseline: { type: 'string' },
        apps: { type: 'string' },
        fixture: { type: 'string' },
        'write-baseline': { type: 'boolean', default: false },
        retries: { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false }
      },
      allowPositionals: false
    });
  } catch (err) {
    return { exitCode: EXIT.error, stdout: '', stderr: `${err.message}\n${usage()}` };
  }

  if (parsed.values.help) {
    return { exitCode: 0, stdout: usage(), stderr: '' };
  }

  const cwd = options.cwd || process.cwd();
  const baselinePath = resolve(
    cwd,
    parsed.values.baseline || (existsSync(join(cwd, 'baseline.json')) ? 'baseline.json' : join(ROOT, 'baseline.json'))
  );
  const appsDir = resolve(
    cwd,
    parsed.values.apps || (existsSync(join(cwd, 'apps')) ? 'apps' : join(ROOT, 'apps'))
  );

  let baseline;
  let apps;
  try {
    baseline = loadJson(baselinePath);
    apps = loadApps(appsDir);
  } catch (err) {
    return { exitCode: EXIT.error, stdout: '', stderr: `failed to load baseline or apps: ${err.message}\n` };
  }

  const checkedAt = options.now ? options.now() : new Date();
  let live;
  try {
    if (parsed.values.fixture) {
      live = loadJson(resolve(cwd, parsed.values.fixture));
      if (!live.source) live.source = DEFAULT_SOURCE;
      if (live.ok === undefined) live.ok = true;
    } else {
      live = await fetchLive({
        source: parsed.values.source || baseline.source || DEFAULT_SOURCE,
        chainId: parsed.values['chain-id'] || baseline.chainId || DEFAULT_CHAIN,
        fetchImpl: options.fetchImpl,
        retries: parsed.values.retries ? Number(parsed.values.retries) : DEFAULT_RETRIES,
        timeoutMs: parsed.values.timeout ? Number(parsed.values.timeout) : DEFAULT_TIMEOUT_MS,
        sleep: options.sleep
      });
    }
  } catch (err) {
    live = { ok: false, error: err.message || 'fetch failed', warnings: [], endpoints: {} };
  }

  const report = compare({ live, baseline, apps });
  const asJson = !!parsed.values.json;
  let stdout = asJson ? formatJson(report, checkedAt) : formatText(report, checkedAt);
  let stderr = '';

  if (parsed.values['write-baseline']) {
    if (!live.ok) {
      stderr += 'refusing to write baseline: live fetch did not succeed\n';
      return { exitCode: EXIT.error, stdout, stderr, report };
    }
    const next = liveToBaseline(live, baseline);
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
    const note = `wrote ${baselinePath}; review and commit if the new values are accepted\n`;
    if (asJson) stderr += note;
    else stdout += note;
  }

  return { exitCode: report.exitCode, stdout, stderr, report };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  run().then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });
}
