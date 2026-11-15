function pt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
  return `${text} (PT)`;
}

function shortHash(value) {
  if (typeof value !== 'string') return String(value);
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function renderValue(value) {
  if (value === null || value === undefined) return '(not observed)';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return value;
  return String(value);
}

function lineForEvidence(item) {
  const mark = item.result === 'compatible' ? 'ok' : item.result;
  if (item.result === 'compatible' && !item.why) {
    return `  - ${item.field}: ${mark} (${renderValue(item.live ?? item.expected)})`;
  }
  if (item.result === 'compatible') {
    return `  - ${item.field}: ${mark} — ${item.why}`;
  }
  return `  - ${item.field}: ${mark} — ${item.why || 'changed'} (expected ${renderValue(item.expected)}; live ${renderValue(item.live)})`;
}

export function formatText(report, checkedAt = new Date()) {
  const lines = [];
  lines.push('PoA compatibility check');
  lines.push(`Source: ${report.live?.source || 'https://minepoa.com'}`);
  lines.push(`Checked: ${pt(checkedAt)}`);
  if (report.error) {
    lines.push('');
    lines.push(`Checker error: ${report.error}`);
    if (report.warnings?.length) {
      lines.push('Warnings:');
      for (const warning of report.warnings) {
        lines.push(`  - ${warning.code}${warning.path ? ` ${warning.path}` : ''}${warning.why || warning.detail ? `: ${warning.why || warning.detail}` : ''} (status ${warning.status ?? 'n/a'}, attempts ${warning.attempts ?? 'n/a'})`);
      }
    }
    lines.push('');
    lines.push('Overall: error (exit 3)');
    return lines.join('\n') + '\n';
  }

  const live = report.live || {};
  lines.push('');
  lines.push('Live core');
  lines.push(`  chain_id:            ${renderValue(live.chainId)}`);
  lines.push(`  engine_sha256:       ${renderValue(live.engineSha256)}`);
  lines.push(`  params_sha256:       ${renderValue(live.paramsSha256)}`);
  lines.push(`  client_bundle_sha256: ${renderValue(live.clientBundleSha256)}`);
  lines.push(`  K:                   ${renderValue(live.K)}`);
  lines.push(`  decimals:            ${renderValue(live.decimals)}`);
  if (live.status) {
    lines.push(
      `  status:              epochs_closed=${renderValue(live.status.epochsClosed)} checkpoint_height=${renderValue(live.status.checkpointHeight)} txs=${renderValue(live.status.txs)} final=${renderValue(live.status.final)}`
    );
  }
  lines.push(`  receipt fields:      ${live.receiptObserved ? live.receiptFields.join(', ') : '(not observed)'}`);
  lines.push(
    `  transfer body:       ${live.transferObserved ? live.transferBodyFields.join(', ') : '(not observed in sample window)'}`
  );

  if (report.baseline) {
    lines.push('');
    lines.push(`Baseline: ${report.baseline.classification}`);
    for (const item of report.baseline.evidence) lines.push(lineForEvidence(item));
    for (const note of report.baseline.notes || []) lines.push(`  note: ${note}`);
  }

  lines.push('');
  lines.push('Apps');
  for (const app of report.apps || []) {
    lines.push(`  ${app.id}: ${app.classification}`);
    for (const item of app.evidence) lines.push('  ' + lineForEvidence(item).trim());
    for (const note of app.notes || []) lines.push(`    note: ${note}`);
  }

  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings');
    for (const warning of report.warnings) {
      const path = warning.path || (warning.paths ? warning.paths.join(', ') : '');
      const detail = warning.why || warning.detail || '';
      const persist = warning.persistent ? ' persistent after retries' : '';
      lines.push(`  - ${warning.code}${path ? ` ${path}` : ''}${detail ? `: ${detail}` : ''}${persist}${warning.status != null ? ` (HTTP ${warning.status}, ${warning.attempts || 1} attempt(s))` : ''}`);
    }
  }

  lines.push('');
  lines.push(`Overall: ${report.classification} (exit ${report.exitCode})`);
  return lines.join('\n') + '\n';
}

export function formatJson(report, checkedAt = new Date()) {
  const body = {
    classification: report.classification,
    exitCode: report.exitCode,
    checkedAt: new Date(checkedAt).toISOString(),
    error: report.error || null,
    live: report.live
      ? {
          source: report.live.source,
          chainId: report.live.chainId,
          engineSha256: report.live.engineSha256,
          paramsSha256: report.live.paramsSha256,
          clientBundleSha256: report.live.clientBundleSha256,
          clientBundleUrls: report.live.clientBundleUrls,
          K: report.live.K,
          decimals: report.live.decimals,
          receiptFields: report.live.receiptFields,
          receiptObserved: report.live.receiptObserved,
          explorerTxFields: report.live.explorerTxFields,
          explorerObserved: report.live.explorerObserved,
          transferBodyFields: report.live.transferBodyFields,
          transferObserved: report.live.transferObserved,
          status: report.live.status || null,
          endpoints: Object.fromEntries(
            Object.entries(report.live.endpoints || {}).filter(([path]) => !/[0-9a-f]{64}/i.test(path))
          )
        }
      : null,
    baseline: report.baseline,
    apps: report.apps,
    warnings: report.warnings
  };
  return JSON.stringify(body, null, 2) + '\n';
}

export { pt, shortHash };
