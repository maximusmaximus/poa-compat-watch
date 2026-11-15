// Compare two extracted surfaces and decide which differences matter to a consuming project.

/**
 * uses (all optional; when a list is absent every item of that kind counts as relied on):
 *   exports:   export names the project imports or mirrors
 *   txTypes:   transaction types the project builds or reads
 *   fields:    { body: [...], receipt: [...], ... } shape fields the project reads/writes
 *   constants: constant names whose value must not change
 *   critical:  function names whose code defines a wire format (any code change is breaking)
 */
export function compareSurfaces(oldS, newS, uses = {}) {
  const changes = [];
  const add = (severity, kind, name, detail) => changes.push({ severity, kind, name, detail });
  const relied = (list, name) => !Array.isArray(list) || list.includes(name);

  const oe = oldS.exports || {}, ne = newS.exports || {};
  for (const name of Object.keys(oe)) {
    if (!(name in ne)) { add(relied(uses.exports, name) ? 'breaking' : 'info', 'export-removed', name, `export \`${name}\` was removed`); continue; }
    const a = oe[name], b = ne[name];
    if (a.kind !== b.kind && !(isFn(a.kind) && isFn(b.kind))) add(relied(uses.exports, name) ? 'breaking' : 'info', 'export-kind', name, `export \`${name}\` changed from ${a.kind} to ${b.kind}`);
    else if (a.params != null && b.params != null && a.params !== b.params) {
      const additive = b.params.startsWith(a.params + ',') || (a.params === '' && b.params !== '');
      add(additive ? 'review' : relied(uses.exports, name) ? 'breaking' : 'info', 'signature', name,
        `\`${name}(${a.params})\` is now \`${name}(${b.params})\`${additive ? ' (new optional-looking trailing parameter)' : ''}`);
    }
  }
  for (const name of Object.keys(ne)) if (!(name in oe)) add('info', 'export-added', name, `new export \`${name}\``);

  for (const name of uses.critical || []) {
    const a = oldS.functions?.[name], b = newS.functions?.[name];
    if (!a && !b) continue;
    if (a && !b) add('breaking', 'critical-removed', name, `critical function \`${name}\` no longer exists`);
    else if (!a && b) add('review', 'critical-added', name, `critical function \`${name}\` appeared`);
    else if (a.bodyHash !== b.bodyHash || a.params !== b.params) add('breaking', 'critical-changed', name, `code of critical function \`${name}\` changed`);
  }
  // Non-critical exported function bodies that changed: worth a look, never blocking.
  for (const name of Object.keys(ne)) {
    if ((uses.critical || []).includes(name)) continue;
    const a = oldS.functions?.[name], b = newS.functions?.[name];
    if (a && b && a.bodyHash !== b.bodyHash && relied(uses.exports, name) && Array.isArray(uses.exports))
      add('review', 'code-changed', name, `code of \`${name}\` changed`);
  }

  const ot = new Set(oldS.txTypes || []), nt = new Set(newS.txTypes || []);
  for (const t of ot) if (!nt.has(t)) add(relied(uses.txTypes, t) ? 'breaking' : 'info', 'txtype-removed', t, `transaction type \`${t}\` no longer appears`);
  for (const t of nt) if (!ot.has(t)) add('info', 'txtype-added', t, `new transaction type \`${t}\``);

  const fieldUses = uses.fields || {};
  for (const shape of new Set([...Object.keys(oldS.shapes || {}), ...Object.keys(newS.shapes || {})])) {
    const a = new Set(oldS.shapes?.[shape] || []), b = new Set(newS.shapes?.[shape] || []);
    const list = fieldUses[shape];
    for (const f of a) if (!b.has(f)) add(Array.isArray(list) ? (list.includes(f) ? 'breaking' : 'info') : 'review', 'field-removed', `${shape}.${f}`, `\`${shape}.${f}\` is no longer referenced`);
    for (const f of b) if (!a.has(f)) add('info', 'field-added', `${shape}.${f}`, `new field \`${shape}.${f}\``);
  }

  const oc = oldS.constants || {}, nc = newS.constants || {};
  for (const k of new Set([...Object.keys(oc), ...Object.keys(nc)])) {
    if (oc[k] === nc[k]) continue;
    const watched = Array.isArray(uses.constants) && uses.constants.includes(k);
    const what = !(k in nc) ? 'was removed' : !(k in oc) ? 'was added' : 'changed value';
    add(watched ? 'breaking' : 'info', 'constant', k, `constant \`${k}\` ${what}`);
  }
  const breaking = changes.filter((c) => c.severity === 'breaking');
  const review = changes.filter((c) => c.severity === 'review');
  return {
    breaking: breaking.length > 0,
    counts: { breaking: breaking.length, review: review.length, info: changes.length - breaking.length - review.length },
    changes,
  };
}

const isFn = (k) => /function|generator/.test(k || '');

/** Check required values in network facts / status: { "chain_id": "poa-mainnet-1", "economics.K": 5, "checkpoint.height": "present" } */
export function checkExpectations(obj, expect = {}) {
  const problems = [];
  for (const [path, want] of Object.entries(expect || {})) {
    const got = getPath(obj, path);
    if (want === 'present') { if (got === undefined || got === null) problems.push(`\`${path}\` is missing`); }
    else if (got !== want) problems.push(`\`${path}\` is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  return problems;
}

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
