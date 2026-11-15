const HISTORY_MAX = 100;

export function reportSignature(report) {
  const apps = (report.apps || [])
    .map((app) => `${app.id}:${app.classification}`)
    .sort()
    .join(',');
  const live = report.live || {};
  const warningCodes = [...new Set((report.warnings || []).map((w) => w.code))].sort().join(',');
  return [
    report.classification,
    String(report.exitCode ?? ''),
    live.chainId ?? '',
    live.engineSha256 ?? '',
    live.paramsSha256 ?? '',
    live.clientBundleSha256 ?? '',
    String(live.K ?? ''),
    String(live.decimals ?? ''),
    apps,
    warningCodes
  ].join('|');
}

export function changeSummary(previous, next) {
  const changes = [];
  if (!previous) {
    changes.push({ field: 'initial', result: next.classification });
    return changes;
  }
  if (previous.classification !== next.classification) {
    changes.push({ field: 'classification', expected: previous.classification, live: next.classification });
  }
  const prevLive = previous.live || {};
  const nextLive = next.live || {};
  for (const field of ['chainId', 'engineSha256', 'paramsSha256', 'clientBundleSha256', 'K', 'decimals']) {
    if (prevLive[field] !== nextLive[field]) {
      changes.push({ field, expected: prevLive[field] ?? null, live: nextLive[field] ?? null });
    }
  }
  const prevApps = new Map((previous.apps || []).map((app) => [app.id, app.classification]));
  const nextApps = new Map((next.apps || []).map((app) => [app.id, app.classification]));
  for (const [id, classification] of nextApps) {
    if (prevApps.get(id) !== classification) {
      changes.push({ field: `app:${id}`, expected: prevApps.get(id) ?? null, live: classification });
    }
  }
  return changes;
}

export function nextHistory(previousLatest, history, report, max = HISTORY_MAX) {
  const list = Array.isArray(history) ? history.slice() : [];
  const signature = reportSignature(report);
  const previousSig = previousLatest ? reportSignature(previousLatest) : null;
  if (previousSig === signature) return { history: list, changed: false, signature };
  const entry = {
    checkedAt: report.checkedAt,
    classification: report.classification,
    exitCode: report.exitCode,
    signature,
    changes: changeSummary(previousLatest, report),
    apps: (report.apps || []).map((app) => ({ id: app.id, classification: app.classification })),
    baseline: report.baseline ? report.baseline.classification : null
  };
  list.unshift(entry);
  return { history: list.slice(0, max), changed: true, signature, entry };
}

export { HISTORY_MAX };
