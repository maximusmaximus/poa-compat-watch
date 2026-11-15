const RANK = { compatible: 0, 'needs-update': 1, breaking: 2 };
export const EXIT = { compatible: 0, 'needs-update': 1, breaking: 2, error: 3 };

export function worse(a, b) {
  const left = RANK[a] ?? -1;
  const right = RANK[b] ?? -1;
  return right > left ? b : a;
}

export function overallExit(classification, checkerError) {
  if (checkerError) return EXIT.error;
  return EXIT[classification] ?? EXIT.error;
}

function evidence(list, item) {
  list.push(item);
  return item.result;
}

function pinCompare(evidenceList, field, expected, live, onMismatch, extra = {}) {
  if (expected === undefined || expected === null) return 'compatible';
  if (live === undefined || live === null) {
    return evidence(evidenceList, {
      field,
      expected,
      live: null,
      result: 'needs-update',
      why: `${field} was not observed on the live node`,
      ...extra
    });
  }
  if (Object.is(expected, live)) {
    evidence(evidenceList, { field, expected, live, result: 'compatible', ...extra });
    return 'compatible';
  }
  const result = onMismatch || 'needs-update';
  return evidence(evidenceList, {
    field,
    expected,
    live,
    result,
    why: `${field} changed`,
    ...extra
  });
}

function missingFields(expected, actual) {
  const have = new Set(actual || []);
  return (expected || []).filter((name) => !have.has(name));
}

function extraFields(expected, actual) {
  const want = new Set(expected || []);
  return (actual || []).filter((name) => !want.has(name));
}

function shapeSatisfied(required, actual) {
  const have = new Set(actual || []);
  return (required || []).every((name) => have.has(name));
}

function endpointOk(live, path) {
  const row = live.endpoints?.[path];
  return !!(row && row.ok);
}

function capabilityStatus(live, cap) {
  const paths = cap.paths || [];
  const hits = paths.map((path) => ({ path, row: live.endpoints?.[path] }));
  const ok = hits.some((hit) => hit.row && hit.row.ok);
  const seen = hits.filter((hit) => hit.row);
  const persistentFail = seen.length > 0 && seen.every((hit) => hit.row && !hit.row.ok);
  return { ok, hits, persistentFail, required: !!cap.required, flaky: !!cap.flaky, name: cap.name, paths };
}

export function compareBaseline(live, baseline) {
  const items = [];
  let classification = 'compatible';
  const notes = [];

  classification = worse(classification, pinCompare(items, 'chainId', baseline.chainId, live.chainId, 'breaking'));
  classification = worse(classification, pinCompare(items, 'engineSha256', baseline.engineSha256, live.engineSha256, 'needs-update'));
  classification = worse(classification, pinCompare(items, 'paramsSha256', baseline.paramsSha256, live.paramsSha256, 'needs-update'));
  classification = worse(
    classification,
    pinCompare(items, 'clientBundleSha256', baseline.clientBundleSha256, live.clientBundleSha256, 'needs-update')
  );
  classification = worse(classification, pinCompare(items, 'K', baseline.K, live.K, 'needs-update'));
  classification = worse(classification, pinCompare(items, 'decimals', baseline.decimals, live.decimals, 'breaking'));

  if (live.receiptObserved) {
    const missing = missingFields(baseline.receiptFields, live.receiptFields);
    const extra = extraFields(baseline.receiptFields, live.receiptFields);
    if (missing.length) {
      classification = worse(classification, 'needs-update');
      items.push({
        field: 'receiptFields',
        expected: baseline.receiptFields,
        live: live.receiptFields,
        missing,
        result: 'needs-update',
        why: `live receipt is missing baseline fields: ${missing.join(', ')}`
      });
    } else {
      items.push({
        field: 'receiptFields',
        expected: baseline.receiptFields,
        live: live.receiptFields,
        extra,
        result: 'compatible',
        why: extra.length ? `live receipt adds optional fields: ${extra.join(', ')}` : 'receipt field set matches'
      });
    }
  } else {
    notes.push('receipt field set was not observed');
  }

  if (live.explorerObserved) {
    const missing = missingFields(baseline.explorerTxFields, live.explorerTxFields);
    const extra = extraFields(baseline.explorerTxFields, live.explorerTxFields);
    if (missing.length) {
      classification = worse(classification, 'needs-update');
      items.push({
        field: 'explorerTxFields',
        expected: baseline.explorerTxFields,
        live: live.explorerTxFields,
        missing,
        result: 'needs-update',
        why: `live explorer tx is missing baseline fields: ${missing.join(', ')}`
      });
    } else {
      items.push({
        field: 'explorerTxFields',
        expected: baseline.explorerTxFields,
        live: live.explorerTxFields,
        extra,
        result: 'compatible'
      });
    }
  } else {
    notes.push('explorer tx shape was not observed');
  }

  if (live.transferObserved) {
    const missing = missingFields(baseline.transferBodyFields, live.transferBodyFields);
    if (missing.length) {
      classification = worse(classification, 'breaking');
      items.push({
        field: 'transferBodyFields',
        expected: baseline.transferBodyFields,
        live: live.transferBodyFields,
        missing,
        result: 'breaking',
        why: `observed transfer body is missing required fields: ${missing.join(', ')}`
      });
    } else {
      items.push({
        field: 'transferBodyFields',
        expected: baseline.transferBodyFields,
        live: live.transferBodyFields,
        result: 'compatible'
      });
    }
  } else {
    notes.push('no transfer tx in the sample window; transfer body field set was not re-verified');
  }

  const capabilityWarnings = [];
  for (const cap of baseline.capabilities || []) {
    const status = capabilityStatus(live, cap);
    if (status.ok) continue;
    const observed = status.hits.some((hit) => hit.row);
    if (!observed) continue;
    if (status.persistentFail && status.required && !status.flaky) {
      classification = worse(classification, 'needs-update');
      items.push({
        field: `capability:${cap.name}`,
        expected: cap.paths,
        live: status.hits.map((hit) => ({ path: hit.path, ...(hit.row || { ok: false }) })),
        result: 'needs-update',
        why: `required capability ${cap.name} failed on every path after retries`
      });
    } else {
      capabilityWarnings.push({
        code: status.flaky || !status.required ? 'AVAILABILITY' : 'ENDPOINT_UNAVAILABLE',
        capability: cap.name,
        paths: cap.paths,
        persistent: status.persistentFail,
        why: status.flaky
          ? `${cap.name} is marked flaky and was unavailable`
          : `${cap.name} was unavailable; treated as an availability warning`
      });
    }
  }

  return { id: 'baseline', classification, evidence: items, notes, capabilityWarnings };
}

export function compareApp(live, app) {
  const items = [];
  let classification = 'compatible';
  const notes = [];
  const pins = app.pins || {};

  if (pins.chainId) {
    classification = worse(
      classification,
      pinCompare(items, 'chainId', pins.chainId.value, live.chainId, pins.chainId.onMismatch || 'breaking', {
        files: pins.chainId.files
      })
    );
  }
  if (pins.engineSha256) {
    classification = worse(
      classification,
      pinCompare(items, 'engineSha256', pins.engineSha256.value, live.engineSha256, pins.engineSha256.onMismatch || 'needs-update', {
        files: pins.engineSha256.files
      })
    );
  }
  if (pins.paramsSha256) {
    classification = worse(
      classification,
      pinCompare(items, 'paramsSha256', pins.paramsSha256.value, live.paramsSha256, pins.paramsSha256.onMismatch || 'needs-update', {
        files: pins.paramsSha256.files
      })
    );
  }
  if (pins.decimals) {
    classification = worse(
      classification,
      pinCompare(items, 'decimals', pins.decimals.value, live.decimals, pins.decimals.onMismatch || 'breaking', {
        files: pins.decimals.files
      })
    );
  }
  if (pins.K) {
    classification = worse(
      classification,
      pinCompare(items, 'K', pins.K.value, live.K, pins.K.onMismatch || 'needs-update', { files: pins.K.files })
    );
  }

  if (app.receiptPolicy === 'any-shape' && Array.isArray(app.receiptShapes)) {
    if (live.receiptObserved) {
      const matched = app.receiptShapes.filter((shape) => shapeSatisfied(shape.required, live.receiptFields));
      if (matched.length === 0) {
        classification = worse(classification, 'breaking');
        items.push({
          field: 'receiptShapes',
          expected: app.receiptShapes,
          live: live.receiptFields,
          result: 'breaking',
          why: 'live receipt matched none of the accepted shapes'
        });
      } else {
        items.push({
          field: 'receiptShapes',
          expected: app.receiptShapes.map((s) => s.name),
          live: live.receiptFields,
          matched: matched.map((s) => s.name),
          result: 'compatible'
        });
      }
    } else {
      notes.push('receipt shape was not observed');
    }
  } else if (Array.isArray(app.receiptFields) && app.receiptFields.length) {
    if (live.receiptObserved) {
      const missing = missingFields(app.receiptFields, live.receiptFields);
      if (missing.length) {
        classification = worse(classification, 'breaking');
        items.push({
          field: 'receiptFields',
          expected: app.receiptFields,
          live: live.receiptFields,
          missing,
          result: 'breaking',
          why: `live receipt is missing required fields: ${missing.join(', ')}`
        });
      } else {
        items.push({
          field: 'receiptFields',
          expected: app.receiptFields,
          live: live.receiptFields,
          result: 'compatible'
        });
      }
    } else {
      notes.push('receipt field set was not observed');
    }
  }

  if (Array.isArray(app.transferBodyFields) && app.transferBodyFields.length) {
    if (live.transferObserved) {
      const missing = missingFields(app.transferBodyFields, live.transferBodyFields);
      if (missing.length) {
        classification = worse(classification, 'breaking');
        items.push({
          field: 'transferBodyFields',
          expected: app.transferBodyFields,
          live: live.transferBodyFields,
          missing,
          result: 'breaking',
          why: `observed transfer body is missing required fields: ${missing.join(', ')}`
        });
      } else {
        items.push({
          field: 'transferBodyFields',
          expected: app.transferBodyFields,
          live: live.transferBodyFields,
          result: 'compatible'
        });
      }
    } else {
      notes.push('no transfer tx in the sample window; transfer body field set was not re-verified');
    }
  }

  return { id: app.id, name: app.name, repo: app.repo, classification, evidence: items, notes };
}

function dedupeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const warning of list) {
    const key = `${warning.code}|${warning.path || (warning.paths || []).join(',')}|${warning.capability || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out;
}

export function compare({ live, baseline, apps = [] }) {
  if (!live || live.ok === false) {
    return {
      classification: 'error',
      exitCode: EXIT.error,
      error: live?.error || 'live observation failed',
      baseline: null,
      apps: [],
      warnings: live?.warnings || [],
      live
    };
  }

  const baselineResult = compareBaseline(live, baseline);
  const appResults = apps.map((app) => compareApp(live, app));
  let classification = baselineResult.classification;
  for (const app of appResults) classification = worse(classification, app.classification);

  const warnings = dedupeWarnings([...(live.warnings || []), ...(baselineResult.capabilityWarnings || [])]);
  return {
    classification,
    exitCode: overallExit(classification, false),
    error: null,
    baseline: baselineResult,
    apps: appResults,
    warnings,
    live
  };
}

export { missingFields, shapeSatisfied, endpointOk, capabilityStatus };
