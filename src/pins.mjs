// Read and rewrite the pinned PoA values a project declares.
import fs from 'node:fs';
import path from 'node:path';

/** Strip // and /* *\/ comments and trailing commas so JSONC (e.g. wrangler.jsonc) parses. */
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], d = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += d; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function jsonGet(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Current value of one pin, or { error }. replaceAll pins have no value of their own. */
export function readPin(root, pin) {
  const file = path.join(root, pin.file);
  if (!fs.existsSync(file)) return pin.optional ? { missing: true } : { error: `${pin.file} not found` };
  const text = fs.readFileSync(file, 'utf8');
  if (pin.replaceAll) return { replaceAll: true };
  if (pin.json) {
    let v;
    try { v = jsonGet(parseJsonc(text), pin.json); } catch (e) { return { error: `${pin.file}: ${e.message}` }; }
    if (typeof v !== 'string') return { error: `${pin.file}: ${pin.json} is not a string` };
    return { value: v };
  }
  const re = new RegExp(pin.regex, pin.flags.replace('g', '') + 'g');
  const values = [...text.matchAll(re)].map((m) => m[1]);
  if (!values.length) return { error: `${pin.file}: pattern not found` };
  if (new Set(values).size > 1) return { error: `${pin.file}: pattern matched different values` };
  return { value: values[0] };
}

export function readPins(root, pins) {
  return pins.map((pin) => ({ pin, ...readPin(root, pin) }));
}

/** The pinned value per tracked kind, plus disagreements between locations. */
export function pinnedValues(readResults) {
  const byTrack = {};
  const problems = [];
  for (const r of readResults) {
    if (r.error) { problems.push(r.error); continue; }
    if (r.value === undefined) continue;
    (byTrack[r.pin.tracks] ||= new Set()).add(r.value);
  }
  const values = {};
  for (const [k, set] of Object.entries(byTrack)) {
    if (set.size > 1) problems.push(`pinned ${k} values disagree across files: ${[...set].map((v) => v.slice(0, 12)).join(', ')}`);
    values[k] = [...set][0];
  }
  return { values, problems };
}

/** Rewrite pins in place. `from` and `to` map track -> value. Returns list of changed files. */
export function writePins(root, pins, from, to) {
  const changed = new Set();
  const notes = [];
  for (const pin of pins) {
    const oldV = from[pin.tracks], newV = to[pin.tracks];
    if (!newV || oldV === newV) continue;
    const file = path.join(root, pin.file);
    if (!fs.existsSync(file)) { if (!pin.optional) notes.push(`${pin.file} not found`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    let next = text;
    if (pin.replaceAll || pin.json) {
      if (!oldV) { notes.push(`${pin.id}: previous ${pin.tracks} value unknown, skipped`); continue; }
      if (pin.json) {
        const key = String(pin.json).split('.').pop();
        const re = new RegExp(`("${escapeRe(key)}"\\s*:\\s*")${escapeRe(oldV)}(")`, 'g');
        const hits = (text.match(re) || []).length;
        if (hits === 0) { notes.push(`${pin.id}: value not found for rewrite`); continue; }
        next = text.replace(re, `$1${newV}$2`);
      } else {
        if (!text.includes(oldV)) { notes.push(`${pin.id}: no occurrence of the previous value`); continue; }
        next = text.split(oldV).join(newV);
      }
    } else {
      const re = new RegExp(pin.regex, pin.flags.replace('g', '') + 'g');
      next = text.replace(re, (whole, cap) => whole.replace(cap, newV));
    }
    if (next !== text) { fs.writeFileSync(file, next); changed.add(pin.file); }
  }
  return { changed: [...changed], notes };
}
